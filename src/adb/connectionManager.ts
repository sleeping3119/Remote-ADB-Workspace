import * as cp from 'child_process';
import { PlatformToolsManager } from './platformToolsManager';
import { Logger } from '../logger';

export interface AdbDevice {
    id: string;
    status: string;
}

export class PersistentAdbShell {
    private process: cp.ChildProcess;
    private buffer: string = '';
    private currentResolve: ((data: string) => void) | null = null;
    private currentReject: ((err: Error) => void) | null = null;
    private commandQueue: { command: string, resolve: (data: string) => void, reject: (err: Error) => void }[] = [];
    private isBusy = false;
    private currentUser: { name: string, groups: string[] } | null = null;

    public async getCurrentUser(): Promise<{ name: string, groups: string[] }> {
        if (this.currentUser) return this.currentUser;
        
        try {
            // Using 'toybox id' ensures consistent output across devices. 
            // If toybox isn't in PATH, 'id' is a fallback.
            const nameStr = await this.executeCommand('toybox id -un 2>/dev/null || id -un');
            const groupsStr = await this.executeCommand('toybox id -Gn 2>/dev/null || id -Gn');
            this.currentUser = {
                name: nameStr.trim(),
                groups: groupsStr.trim().split(/\s+/)
            };
        } catch (e) {
            this.currentUser = { name: 'shell', groups: ['shell'] };
        }
        return this.currentUser;
    }

    constructor(adbPath: string, deviceId: string) {
        // -x might not be needed, just using standard shell
        this.process = cp.spawn(adbPath, ['-s', deviceId, 'shell']);
        
        this.process.stdout?.on('data', (data) => {
            this.buffer += data.toString();
            this.checkBuffer();
        });

        this.process.stderr?.on('data', (data) => {
            this.buffer += data.toString();
            this.checkBuffer();
        });

        this.process.on('close', () => {
            if (this.currentReject) {
                this.currentReject(new Error('ADB shell closed unexpectedly'));
            }
            while (this.commandQueue.length > 0) {
                this.commandQueue.shift()?.reject(new Error('ADB shell closed'));
            }
        });

        // Try to disable echo if possible, ignore if it fails
        this.process.stdin?.write('stty -echo 2>/dev/null\n');
    }

    private checkBuffer() {
        const delimiter = '__ADB_EOF__';
        const matchIndex = this.buffer.indexOf(delimiter);

        if (matchIndex !== -1 && this.currentResolve) {
            let output = this.buffer.substring(0, matchIndex);
            
            // The delimiter might have a newline after it
            let splitIndex = matchIndex + delimiter.length;
            if (this.buffer[splitIndex] === '\r') {splitIndex++;}
            if (this.buffer[splitIndex] === '\n') {splitIndex++;}
            
            this.buffer = this.buffer.substring(splitIndex);
            
            const resolve = this.currentResolve;
            this.currentResolve = null;
            this.currentReject = null;
            this.isBusy = false;
            
            if (output.trim()) {
                Logger.logOutput(`[Persistent Shell] ${output.trim()}`);
            }
            resolve(output.trim());
            this.processNext();
        }
    }

    public async executeCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.commandQueue.push({ command, resolve, reject });
            this.processNext();
        });
    }

    private processNext() {
        if (this.isBusy || this.commandQueue.length === 0) {return;}
        
        this.isBusy = true;
        const next = this.commandQueue.shift()!;
        this.currentResolve = next.resolve;
        this.currentReject = next.reject;
        
        // Execute the command in a subshell or group to capture all output
        // and echo the delimiter immediately after.
        Logger.logCommand(`[Persistent Shell] ${next.command}`);
        this.process.stdin?.write(`(${next.command}) 2>&1; echo __ADB_EOF__\n`);
    }
    
    public close() {
        this.process.kill();
    }
}

export class ConnectionManager {
    public toolsManager: PlatformToolsManager;
    private activeDeviceId: string | undefined;
    private shells: Map<string, PersistentAdbShell> = new Map();
    private deviceIdMap: Map<string, string> = new Map();

    constructor(toolsManager: PlatformToolsManager) {
        this.toolsManager = toolsManager;
    }

    public setActiveDevice(deviceId: string) {
        this.activeDeviceId = deviceId;
        this.deviceIdMap.set(deviceId.toLowerCase(), deviceId);
    }

    public getActiveDevice(): string | undefined {
        return this.activeDeviceId;
    }

    public async resolveDeviceId(idFromUri: string): Promise<string> {
        const lower = idFromUri.toLowerCase();
        if (this.deviceIdMap.has(lower)) {
            return this.deviceIdMap.get(lower)!;
        }
        
        // Map is empty or device not found, try fetching current devices to populate the map
        await this.getDevices();
        
        return this.deviceIdMap.get(lower) || idFromUri;
    }

    public async getPersistentShell(deviceId: string): Promise<PersistentAdbShell> {
        const realId = await this.resolveDeviceId(deviceId);
        if (!this.shells.has(realId)) {
            const adbPath = await this.toolsManager.getAdbPath();
            this.shells.set(realId, new PersistentAdbShell(adbPath, realId));
        }
        return this.shells.get(realId)!;
    }

    public async closePersistentShell(deviceId: string): Promise<void> {
        const realId = await this.resolveDeviceId(deviceId);
        const shell = this.shells.get(realId);
        if (shell) {
            shell.close();
            this.shells.delete(realId);
        }
    }

    private pendingGetDevices: Promise<AdbDevice[]> | null = null;

    public async getDevices(): Promise<AdbDevice[]> {
        if (this.pendingGetDevices) {
            return this.pendingGetDevices;
        }

        this.pendingGetDevices = (async () => {
            try {
                const output = await this.executeAdbCommand('devices');
                const lines = output.split('\n');
                const devices: AdbDevice[] = [];
                
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line) {
                        const parts = line.split('\t');
                        if (parts.length === 2) {
                            const id = parts[0];
                            this.deviceIdMap.set(id.toLowerCase(), id);
                            devices.push({ id, status: parts[1] });
                        }
                    }
                }
                return devices;
            } finally {
                this.pendingGetDevices = null;
            }
        })();

        return this.pendingGetDevices;
    }

    public async executeCommandForDevice(deviceId: string, args: string): Promise<string> {
        const realId = await this.resolveDeviceId(deviceId);
        return this.executeAdbCommand(`-s ${realId} ${args}`);
    }

    public async connect(ipPort: string): Promise<string> {
        return this.executeAdbCommand(`connect ${ipPort}`);
    }

    public async pair(ipPort: string, code: string): Promise<string> {
        return this.executeAdbCommand(`pair ${ipPort} ${code}`);
    }

    public async disconnect(target: string): Promise<string> {
        return this.executeAdbCommand(`disconnect ${target}`);
    }

    public async tcpip(port: string): Promise<string> {
        return this.executeAdbCommand(`tcpip ${port}`);
    }

    public async tryUsb(): Promise<string> {
        return this.executeAdbCommand('usb');
    }

    private async executeAdbCommand(args: string): Promise<string> {
        const adbPath = await this.toolsManager.getAdbPath();
        const cmd = `"${adbPath}" ${args}`;
        // Only log devices command if we really want to, but it's debounced now.
        Logger.logCommand(cmd);
        return new Promise((resolve, reject) => {
            cp.exec(cmd, (error, stdout, stderr) => {
                const combined = (stdout + '\n' + stderr).trim();
                if (error) {
                    if (!combined.includes('No such file or directory') && !combined.includes('does not exist')) {
                        Logger.logError(`[executeAdbCommand] Error: ${error.message}\nOutput: ${combined}`);
                    }
                    reject(new Error(combined || error.message));
                    return;
                }
                // Suppress output logging for pull/push since it's noisy and binary sometimes
                if (!args.startsWith('-s ') || (!args.includes(' pull ') && !args.includes(' push '))) {
                    Logger.logOutput(combined);
                }
                resolve(combined);
            });
        });
    }
}
