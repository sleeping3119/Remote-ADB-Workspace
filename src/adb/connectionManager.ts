import * as vscode from 'vscode';
import * as cp from 'child_process';
import { PlatformToolsManager } from './platformToolsManager';
import { Logger } from '../logger';

export interface AdbDevice {
    id: string;
    status: string;
}

export type SwitchCommandState = { type: 'root' | 'termux' | 'custom' | 'shell', pkgName?: string };

export class PersistentAdbShell {
    public activeSwitchCommand?: SwitchCommandState;
    private process: cp.ChildProcess;
    private buffer: string = '';
    private currentResolve: ((data: string) => void) | null = null;
    private currentReject: ((err: Error) => void) | null = null;
    private commandQueue: { command: string, resolve: (data: string) => void, reject: (err: Error) => void, isRaw?: boolean }[] = [];
    private isBusy = false;
    public isDead = false;
    public isIntendedClose = false;
    public onUnexpectedClose?: () => void;
    private currentUser: { name: string, groups: string[], uid: string, gids: string[] } | null = null;
    private pendingUserPromise: Promise<{ name: string, groups: string[], uid: string, gids: string[] }> | null = null;

    public async getCurrentUser(forceRefresh: boolean = false): Promise<{ name: string, groups: string[], uid: string, gids: string[] }> {
        if (this.currentUser && !forceRefresh) return this.currentUser;
        
        if (this.pendingUserPromise && !forceRefresh) {
            return this.pendingUserPromise;
        }

        this.pendingUserPromise = (async () => {
            try {
                // Using 'toybox id' ensures consistent output across devices. 
                // If toybox isn't in PATH, 'id' is a fallback.
                const nameStr = await this.executeCommand('toybox id -un 2>/dev/null || id -un');
                const groupsStr = await this.executeCommand('toybox id -Gn 2>/dev/null || id -Gn');
                const uidStr = await this.executeCommand('toybox id -u 2>/dev/null || id -u');
                const gidsStr = await this.executeCommand('toybox id -G 2>/dev/null || id -G');
                
                this.currentUser = {
                    name: nameStr.trim(),
                    groups: groupsStr.trim().split(/\s+/),
                    uid: uidStr.trim(),
                    gids: gidsStr.trim().split(/\s+/)
                };
            } catch (e) {
                this.currentUser = { name: 'shell', groups: ['shell'], uid: '2000', gids: ['2000'] };
            } finally {
                this.pendingUserPromise = null;
            }
            return this.currentUser;
        })();

        return this.pendingUserPromise;
    }

    public refreshCurrentUser(): void {
        this.currentUser = null;
        this.pendingUserPromise = null;
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
            this.isDead = true;
            if (this.currentReject) {
                this.currentReject(new Error('ADB shell closed unexpectedly'));
            }
            while (this.commandQueue.length > 0) {
                this.commandQueue.shift()?.reject(new Error('ADB shell closed'));
            }
            this.isBusy = false;
            if (!this.isIntendedClose && this.onUnexpectedClose) {
                this.onUnexpectedClose();
            }
        });

        this.process.on('error', () => {
            this.isDead = true;
            this.isBusy = false;
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

    public async executeCommand(command: string, timeoutMs: number = 15000): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.close();
                reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
            }, timeoutMs);

            this.commandQueue.push({ 
                command, 
                resolve: (res) => { clearTimeout(timer); resolve(res); }, 
                reject: (err) => { clearTimeout(timer); reject(err); } 
            });
            this.processNext();
        });
    }

    public async sendRawCommand(command: string, timeoutMs: number = 15000): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.close();
                reject(new Error(`Raw command timed out after ${timeoutMs}ms: ${command}`));
            }, timeoutMs);

            this.commandQueue.push({
                command,
                isRaw: true,
                resolve: () => { clearTimeout(timer); resolve(); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });
            this.processNext();
        });
    }

    private processNext() {
        if (this.isBusy || this.commandQueue.length === 0) {return;}
        
        const next = this.commandQueue.shift()!;
        
        if (this.isDead || !this.process.stdin?.writable) {
            next.reject(new Error('ADB shell is dead or not writable'));
            this.processNext();
            return;
        }

        this.isBusy = true;
        this.currentResolve = next.resolve;
        this.currentReject = next.reject;
        
        try {
            if (next.isRaw) {
                Logger.logCommand(`[Persistent Shell Raw] ${next.command}`);
                this.process.stdin?.write(`${next.command}\n`);
                
                // For raw commands (like su or run-as), there is no EOF marker.
                // We just wait a short time for the shell to process it, then resolve.
                setTimeout(() => {
                    this.isBusy = false;
                    next.resolve('');
                    this.processNext();
                }, 500);
                return;
            }

            // Execute the command in a subshell or group to capture all output
            // and echo the delimiter immediately after.
            Logger.logCommand(`[Persistent Shell] ${next.command}`);
            this.process.stdin?.write(`(${next.command}) 2>&1; echo __ADB_EOF__\n`);
        } catch (err: any) {
            this.isBusy = false;
            next.reject(new Error(`Failed to write to ADB shell: ${err.message}`));
            this.processNext();
        }
    }
    
    public close() {
        if (!this.isDead) {
            this.isIntendedClose = true;
            this.process.kill();
        }
    }
}

export class ConnectionManager {
    public toolsManager: PlatformToolsManager;
    private context: vscode.ExtensionContext;
    private activeDeviceId: string | undefined;
    private shells: Map<string, PersistentAdbShell> = new Map();
    private deviceIdMap: Map<string, string> = new Map();
    private shellReadyPromise: Promise<void> | null = null;
    private pendingGetDevices: Promise<AdbDevice[]> | null = null;
    
    private adbToAndroidIdMap: Map<string, string> = new Map();
    private androidToAdbIdMap: Map<string, string> = new Map();
    private _onDeviceDisconnected = new vscode.EventEmitter<string>();
    public readonly onDeviceDisconnected = this._onDeviceDisconnected.event;

    constructor(context: vscode.ExtensionContext, toolsManager: PlatformToolsManager) {
        this.context = context;
        this.toolsManager = toolsManager;
    }

    private knownTcpDevices: Set<string> = new Set();

    private getKnownTcpDevices(): string[] {
        return Array.from(this.knownTcpDevices);
    }

    private addKnownTcpDevice(deviceId: string) {
        if (deviceId.includes(':')) {
            this.knownTcpDevices.add(deviceId);
        }
    }

    public setActiveDevice(deviceId: string) {
        this.activeDeviceId = deviceId;
        this.deviceIdMap.set(deviceId.toLowerCase(), deviceId);
    }

    public getActiveDevice(): string | undefined {
        return this.activeDeviceId;
    }

    public setShellInitializing(promise: Promise<void>) {
        this.shellReadyPromise = promise;
    }

    public async waitForShellReady(): Promise<void> {
        if (this.shellReadyPromise) {
            await this.shellReadyPromise;
        }
    }

    public async resolveAndroidIdForDevice(adbDeviceId: string): Promise<string | undefined> {
        if (this.adbToAndroidIdMap.has(adbDeviceId)) {
            return this.adbToAndroidIdMap.get(adbDeviceId);
        }
        try {
            const output = await this.executeAdbCommand(`-s ${adbDeviceId} shell settings get secure android_id`);
            const id = output.trim();
            if (id && id !== 'null') {
                this.adbToAndroidIdMap.set(adbDeviceId, id);
                this.androidToAdbIdMap.set(id, adbDeviceId);
                return id;
            }
        } catch(e) {
            Logger.logWarning(`[ConnectionManager] Failed to get android_id for ${adbDeviceId}: ${e}`);
        }
        return undefined;
    }

    public async resolveDeviceId(idFromUri: string): Promise<string> {
        const lower = idFromUri.toLowerCase();
        
        // Backward compatibility: if it matches a known ADB ID directly
        if (this.deviceIdMap.has(lower)) {
            return this.deviceIdMap.get(lower)!;
        }
        
        // If we already resolved this Android ID
        if (this.androidToAdbIdMap.has(idFromUri)) {
            return this.androidToAdbIdMap.get(idFromUri)!;
        }
        
        // Fetch current devices
        const devices = await this.getDevices();
        const connectedDevices = devices.filter(d => d.status === 'device');
        
        // Resolve Android IDs for all currently connected devices
        for (const dev of connectedDevices) {
            await this.resolveAndroidIdForDevice(dev.id);
        }
        
        // Check again after resolving
        if (this.androidToAdbIdMap.has(idFromUri)) {
            return this.androidToAdbIdMap.get(idFromUri)!;
        }
        
        return this.deviceIdMap.get(lower) || idFromUri;
    }

    private pendingShells: Map<string, Promise<PersistentAdbShell>> = new Map();

    public async getPersistentShell(deviceId: string): Promise<PersistentAdbShell> {
        const realId = await this.resolveDeviceId(deviceId);
        
        let previousSwitchCommand: SwitchCommandState | undefined;
        if (this.shells.has(realId)) {
            const existingShell = this.shells.get(realId)!;
            if (!existingShell.isDead) {
                return existingShell;
            }
            previousSwitchCommand = existingShell.activeSwitchCommand;
            this.shells.delete(realId);
        }

        if (this.pendingShells.has(realId)) {
            return this.pendingShells.get(realId)!;
        }

        const shellPromise = (async () => {
            try {
                const adbPath = await this.toolsManager.getAdbPath();
                const shell = new PersistentAdbShell(adbPath, realId);
                
                shell.onUnexpectedClose = () => {
                    this._onDeviceDisconnected.fire(realId);
                };
                
                // Ensure shell is ready by waiting for a basic command to echo back
                await shell.executeCommand('echo "ADB_INIT_OK"');
                
                if (previousSwitchCommand) {
                    if (previousSwitchCommand.type === 'root') {
                        await shell.sendRawCommand('su');
                    } else if (previousSwitchCommand.type === 'termux') {
                        await shell.sendRawCommand('run-as com.termux');
                    } else if (previousSwitchCommand.type === 'custom' && previousSwitchCommand.pkgName) {
                        await shell.sendRawCommand(`run-as ${previousSwitchCommand.pkgName}`);
                    }
                    shell.activeSwitchCommand = previousSwitchCommand;
                    
                    // Ensure environment switch has settled before querying user
                    await new Promise(res => setTimeout(res, 200));
                    shell.refreshCurrentUser();
                }
                
                this.shells.set(realId, shell);
                return shell;
            } finally {
                this.pendingShells.delete(realId);
            }
        })();

        this.pendingShells.set(realId, shellPromise);
        return shellPromise;
    }

    public getRealDeviceIdSync(idFromUri: string): string {
        const lower = idFromUri.toLowerCase();
        if (this.androidToAdbIdMap.has(idFromUri)) {
            return this.androidToAdbIdMap.get(idFromUri)!;
        }
        if (this.deviceIdMap.has(lower)) {
            return this.deviceIdMap.get(lower)!;
        }
        return idFromUri;
    }

    public getPersistentShellIfExists(deviceId: string): PersistentAdbShell | undefined {
        const realId = this.getRealDeviceIdSync(deviceId);
        return this.shells.get(realId);
    }

    public async getQuickUser(deviceId: string): Promise<string> {
        const shell = this.getPersistentShellIfExists(deviceId);
        if (shell) {
            const user = await shell.getCurrentUser();
            return user.name;
        }
        try {
            const adbPath = await this.toolsManager.getAdbPath();
            const realId = await this.resolveDeviceId(deviceId);
            const cp = require('child_process');
            return await new Promise((resolve) => {
                cp.execFile(adbPath, ['-s', realId, 'shell', 'id', '-un'], (err: any, stdout: string) => {
                    resolve(stdout.trim() || 'shell');
                });
            });
        } catch(e) {
            return 'shell';
        }
    }

    public async closePersistentShell(deviceId: string): Promise<void> {
        const realId = await this.resolveDeviceId(deviceId);
        const shell = this.shells.get(realId);
        if (shell) {
            shell.close();
            this.shells.delete(realId);
        }
    }
    public async getDevices(): Promise<AdbDevice[]> {
        if (this.pendingGetDevices) {
            return this.pendingGetDevices;
        }

        this.pendingGetDevices = (async () => {
            try {
                const output = await this.executeAdbCommand('devices');
                const lines = output.split('\n');
                const devices: AdbDevice[] = [];
                const foundDeviceIds = new Set<string>();
                
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line) {
                        const parts = line.split('\t');
                        if (parts.length === 2) {
                            const id = parts[0];
                            this.deviceIdMap.set(id.toLowerCase(), id);
                            devices.push({ id, status: parts[1] });
                            foundDeviceIds.add(id);
                        }
                    }
                }

                // Add known TCP devices that are missing as 'offline'
                for (const knownId of this.getKnownTcpDevices()) {
                    if (!foundDeviceIds.has(knownId)) {
                        devices.push({ id: knownId, status: 'offline' });
                    }
                }

                return devices;
            } finally {
                this.pendingGetDevices = null;
            }
        })();

        return this.pendingGetDevices;
    }

    public async waitForDeviceReady(deviceId: string, timeoutMs: number = 10000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const devices = await this.getDevices();
            const device = devices.find(d => d.id === deviceId);
            if (device && device.status === 'device') {
                return true;
            }
            await new Promise(res => setTimeout(res, 1000));
        }
        return false;
    }

    public async executeCommandForDevice(deviceId: string, args: string): Promise<string> {
        const realId = await this.resolveDeviceId(deviceId);
        return this.executeAdbCommand(`-s ${realId} ${args}`);
    }

    public async connect(ipPort: string): Promise<string> {
        if (!/^[a-zA-Z0-9.:\-]+$/.test(ipPort)) {
            throw new Error('Invalid IP/Port format');
        }
        const result = await this.executeAdbCommand(`connect ${ipPort}`);
        if (!result.includes('failed to connect to') && !result.includes('actively refused it') && !result.includes('cannot connect to')) {
            this.addKnownTcpDevice(ipPort);
        }
        return result;
    }

    public async killServer(): Promise<string> {
        return this.executeAdbCommand(`kill-server`);
    }

    public async startServer(): Promise<string> {
        return this.executeAdbCommand(`start-server`);
    }

    public async pair(ipPort: string, code: string): Promise<string> {
        if (!/^[a-zA-Z0-9.:\-]+$/.test(ipPort)) {
            throw new Error('Invalid IP/Port format');
        }
        if (!/^[0-9]+$/.test(code)) {
            throw new Error('Invalid pairing code format');
        }
        return this.executeAdbCommand(`pair ${ipPort} ${code}`);
    }

    public async disconnect(target: string): Promise<string> {
        if (!/^[a-zA-Z0-9.:\-]+$/.test(target)) {
            throw new Error('Invalid target format');
        }
        return this.executeAdbCommand(`disconnect ${target}`);
    }

    public async tcpip(port: string): Promise<string> {
        if (!/^[0-9]+$/.test(port)) {
            throw new Error('Invalid port format');
        }
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
            let timeout = 0;
            if (args.startsWith('connect ') || args.startsWith('disconnect ') || args === 'kill-server' || args === 'start-server') {
                timeout = 15000;
            } else if (args === 'devices') {
                timeout = 5000;
            }
            
            cp.exec(cmd, { timeout }, (error, stdout, stderr) => {
                const combined = (stdout + '\n' + stderr).trim();
                
                if (error) {
                    if (!combined.includes('No such file or directory') && !combined.includes('does not exist')) {
                        Logger.logError(`[executeAdbCommand] Error: ${error.message}\nOutput: ${combined}`);
                    }
                    reject(new Error(combined || error.message));
                    return;
                }
                
                // Suppress output logging for devices, pull and push since they're noisy or binary
                if (args !== 'devices' && combined) {
                    if (!args.startsWith('-s ') || (!args.includes(' pull ') && !args.includes(' push '))) {
                        Logger.logOutput(combined);
                    }
                }
                
                resolve(combined);
            });
        });
    }
}
