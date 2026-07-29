import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager } from '../adb/connectionManager';
import { ToyboxManager } from '../adb/toyboxManager';

export interface AdbDirEntry {
    name: string;
    type: vscode.FileType;
    accessible: boolean;
}

export class AdbFileSystemProvider implements vscode.FileSystemProvider {
    private connectionManager: ConnectionManager;
    private toyboxManager: ToyboxManager;
    
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;
    
    constructor(connectionManager: ConnectionManager, toyboxManager: ToyboxManager) {
        this.connectionManager = connectionManager;
        this.toyboxManager = toyboxManager;
    }
    
    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        // Using toybox stat to get FileType (hex mode), Size, and Modification time (seconds since epoch)
        const output = await shell.executeCommand(`${prefix} stat -c "%f %s %Y" "${targetPath}"`);
        
        if (output.includes('No such file') || output.includes('stat: ')) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        
        const parts = output.trim().split(' ');
        if (parts.length < 3) throw vscode.FileSystemError.FileNotFound(uri);
        
        const modeHex = parts[0];
        const size = parseInt(parts[1], 10);
        const mtime = parseInt(parts[2], 10) * 1000;
        
        const modeNum = parseInt(modeHex, 16);
        let type = vscode.FileType.Unknown;
        
        if ((modeNum & 0x4000) === 0x4000) {
            type = vscode.FileType.Directory;
        } else if ((modeNum & 0x8000) === 0x8000) {
            type = vscode.FileType.File;
        } else if ((modeNum & 0xA000) === 0xA000) {
            type = vscode.FileType.SymbolicLink;
        } else {
            // Fallback for root or unknown items
            if (targetPath === '/' || targetPath === '') {
                type = vscode.FileType.Directory;
            } else {
                type = vscode.FileType.File;
            }
        }

        return {
            type: type,
            ctime: mtime,
            mtime: mtime,
            size: size
        };
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        // toybox ls -1p prints one entry per line, with a trailing '/' for directories
        const output = await shell.executeCommand(`${prefix} ls -1p "${targetPath}"`);
        
        if (output.includes('No such file')) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        
        const entries: [string, vscode.FileType][] = [];
        const lines = output.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === './' || trimmed === '../') continue;
            if (trimmed.includes('Permission denied')) continue;
            
            // Check indicator for directories
            if (trimmed.endsWith('/')) {
                entries.push([trimmed.slice(0, -1), vscode.FileType.Directory]);
            } else {
                entries.push([trimmed, vscode.FileType.File]);
            }
        }
        return entries;
    }


    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const tmpFile = path.join(os.tmpdir(), `adb-fs-pull-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
        try {
            await this.connectionManager.executeCommandForDevice(deviceId, `pull "${targetPath}" "${tmpFile}"`);
            const data = await fs.promises.readFile(tmpFile);
            return data;
        } catch (e: any) {
            throw vscode.FileSystemError.FileNotFound(uri);
        } finally {
            if (fs.existsSync(tmpFile)) {
                fs.unlinkSync(tmpFile);
            }
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const tmpFile = path.join(os.tmpdir(), `adb-fs-push-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
        try {
            await fs.promises.writeFile(tmpFile, content);
            await this.connectionManager.executeCommandForDevice(deviceId, `push "${tmpFile}" "${targetPath}"`);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (e: any) {
            throw vscode.FileSystemError.Unavailable(uri);
        } finally {
            if (fs.existsSync(tmpFile)) {
                fs.unlinkSync(tmpFile);
            }
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        await shell.executeCommand(`${prefix} mkdir -p "${targetPath}"`);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        const rmArgs = options.recursive ? '-rf' : '-f';
        await shell.executeCommand(`${prefix} rm ${rmArgs} "${targetPath}"`);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(oldUri.authority);
        const oldPath = oldUri.path;
        const newPath = newUri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        await shell.executeCommand(`${prefix} mv "${oldPath}" "${newPath}"`);
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri }
        ]);
    }


    //Following code is for folder picker and will not be used if workspace is opended already
    private isAccessibleFolderPicker(perms: string, owner: string, group: string, user: { name: string, groups: string[] }): boolean {
        if (user.name === 'root') return true;
        
        let rIndex = 7;
        let xIndex = 9;
        
        if (user.name === owner) {
            rIndex = 1; xIndex = 3;
        } else if (user.groups.includes(group) || group === 'everybody') {
            rIndex = 4; xIndex = 6;
        }
        
        return perms[rIndex] === 'r' && (perms[xIndex] === 'x' || perms[xIndex] === 's' || perms[xIndex] === 't');
    }

    public async readDirectoryWithPermissions(uri: vscode.Uri): Promise<AdbDirEntry[]> {
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        // toybox ls -l prints detailed format. We filter for directories 'd' and symlinks 'l'
        // Using sed to drop total lines or errors if they slip through, but grep '^[dl]' handles it mostly.
        const output = await shell.executeCommand(`${prefix} ls -l "${targetPath}" | ${prefix} grep '^[dl]'`);
        
        if (output.includes('Permission denied')) {
            throw vscode.FileSystemError.NoPermissions(uri);
        }
        if (output.includes('No such file')) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        
        const entries: AdbDirEntry[] = [];
        const lines = output.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Format: drwxr-xr-x 2 shell shell 4096 2024-01-01 12:00 name
            // Note: number of links or size might vary, but we can split by whitespace
            // We use a regex to handle variable whitespace
            const parts = trimmed.split(/\s+/);
            if (parts.length < 7) continue;
            
            const perms = parts[0];
            const owner = parts[2];
            const group = parts[3];
            
            // Reconstruct name because it might contain spaces
            // The time is usually at index 5 and 6 (Date Time) or index 6 and 7.
            // Let's just find the first index that contains a colon (like 12:00) 
            // or we can slice based on known fixed counts. Usually ls -l has 8 columns before name.
            // Actually, Android ls -l format:
            // drwxr-x--- 2 root shell 4096 2023-11-01 10:10 my folder
            // 0:perms 1:links 2:owner 3:group 4:size 5:date 6:time 7+:name
            // Wait, symlinks have "name -> target".
            let nameIndex = 7;
            if (parts[6] && !parts[6].includes(':') && !parts[5].includes(':')) {
                // If it's something different, we might just look for the first part after the time string.
                // A safer way is to just assume nameIndex = 7 for toybox ls -l
            }
            // Safer parsing: find the part with a colon (time)
            for (let i = 4; i < parts.length; i++) {
                if (parts[i].includes(':')) {
                    nameIndex = i + 1;
                    break;
                }
            }
            
            let name = parts.slice(nameIndex).join(' ');
            
            // If symlink, extract just the link name
            if (perms[0] === 'l' && name.includes(' -> ')) {
                name = name.split(' -> ')[0];
            }
            
            if (name === '.' || name === '..' || name === '/' || name.includes('/')) continue;
            if (perms.includes('?')) continue;
            
            const type = perms[0] === 'd' ? vscode.FileType.Directory : vscode.FileType.SymbolicLink;
            const accessible = this.isAccessibleFolderPicker(perms, owner, group, currentUser);
            
            entries.push({ name, type, accessible });
        }
        
        return entries;
    }

    public async isWorkspaceAccessible(uri: vscode.Uri): Promise<boolean> {
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        
        // Use the shell builtin '[' instead of 'toybox test'. The shell builtin correctly 
        // evaluates Android MAC (SELinux) permissions, whereas the toybox binary often gives false positives.
        const output = await shell.executeCommand(`[ -d "${targetPath}" ] && [ -r "${targetPath}" ] && [ -x "${targetPath}" ] && echo "OK"`);
        
        return output.trim() === 'OK';
    }
}
