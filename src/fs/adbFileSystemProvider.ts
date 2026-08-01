import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager } from '../adb/connectionManager';
import { ToyboxManager } from '../adb/toyboxManager';
import { CacheManager } from './cacheManager';

export interface AdbDirEntry {
    name: string;
    type: vscode.FileType;
    accessible: boolean;
}

export class AdbFileSystemProvider implements vscode.FileSystemProvider {
    private connectionManager: ConnectionManager;
    private toyboxManager: ToyboxManager;
    private cacheManager: CacheManager;
    
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;
    
    constructor(connectionManager: ConnectionManager, toyboxManager: ToyboxManager, cacheManager: CacheManager) {
        this.connectionManager = connectionManager;
        this.toyboxManager = toyboxManager;
        this.cacheManager = cacheManager;
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
        
        // Using native shell to check write permission and directory status, then toybox stat
        const shellCmd = `if [ -w "${targetPath}" ]; then echo "W"; else echo "NW"; fi; if [ -d "${targetPath}" ]; then echo "D"; else echo "ND"; fi; ${prefix} stat -c "%f %s %Y" "${targetPath}" 2>/dev/null`;
        const output = await shell.executeCommand(shellCmd);
        
        const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        
        if (lines.length < 3 || lines[2].includes('No such file') || lines[2].includes('stat: ')) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        
        const writeStatus = lines[0];
        const dirStatus = lines[1];
        const parts = lines[2].split(' ');
        if (parts.length < 3) throw vscode.FileSystemError.FileNotFound(uri);
        
        const modeHex = parts[0];
        const size = parseInt(parts[1], 10);
        const mtime = parseInt(parts[2], 10) * 1000;
        
        const modeNum = parseInt(modeHex, 16);
        let type = vscode.FileType.Unknown;
        
        if ((modeNum & 0xA000) === 0xA000) {
            type = vscode.FileType.SymbolicLink | (dirStatus === 'D' ? vscode.FileType.Directory : vscode.FileType.File);
        } else if ((modeNum & 0x4000) === 0x4000) {
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

        const statObj: vscode.FileStat = {
            type: type,
            ctime: mtime,
            mtime: mtime,
            size: size
        };

        if (writeStatus === 'NW') {
            statObj.permissions = vscode.FilePermission.Readonly;
        }

        return statObj;
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        
        // Native shell tests to resolve symlinks and check permissions. 
        // Folders must have r_x, files must have r__. We append |1 for symlinks or |0 for normal files.
        const shellCmd = `cd "${targetPath}" 2>/dev/null && ls -1A | while IFS= read -r f; do is_sym="0"; [ -L "$f" ] && is_sym="1"; if [ -d "$f" ]; then [ -r "$f" ] && [ -x "$f" ] && printf "%s/|%s\\n" "$f" "$is_sym"; elif [ -f "$f" ]; then [ -r "$f" ] && printf "%s|%s\\n" "$f" "$is_sym"; fi; done`;
        const output = await shell.executeCommand(shellCmd);
        
        if (output.includes('No such file') || output.includes('Not a directory') || output.includes('cd: ')) {
            // cd fails if it doesn't exist or permission denied
            if (!output.includes('Permission denied')) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
        }
        
        const entries: [string, vscode.FileType][] = [];
        const lines = output.split('\n');
        const validNames: string[] = [];
        
        for (const line of lines) {
            const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (!cleaned || cleaned === './' || cleaned === '../') continue;
            if (cleaned.includes('Permission denied') || cleaned.includes('cd: ')) continue;
            
            const parts = cleaned.split('|');
            if (parts.length < 2) continue; // safety check
            
            const isSym = parts.pop() === '1'; // pop removes the last element (the 0 or 1 flag)
            let name = parts.join('|'); // re-join in case the filename contained '|'
            
            let type: vscode.FileType;
            if (name.endsWith('/')) {
                name = name.slice(0, -1);
                type = vscode.FileType.Directory;
            } else {
                type = vscode.FileType.File;
            }
            
            if (isSym) {
                type = type | vscode.FileType.SymbolicLink;
            }
            
            entries.push([name, type]);
            validNames.push(name);
        }
        
        // Check local cache and delete files that aren't in legitimate output
        // We only do this if we actually succeeded in reading (no "Permission denied" on cd itself)
        if (!output.includes('Permission denied') && !output.includes('cd: ')) {
            // we will need the workspaceRoot to sync cache. We can extract it from the path or just pass it
            // since we don't have manifest directly here, we assume targetPath is within workspaceRoot.
            // Actually, CacheManager handles mapping. We can just pass the path.
            // Wait, we need workspaceRoot for CacheManager... it uses it to construct cache paths!
            // Let's retrieve workspaceRoot from the manifest in workspaceState?
            // Actually, the simplest way to get workspaceRoot is from the currently active workspace folders.
            const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => uri.path.startsWith(f.uri.path));
            if (workspaceFolder) {
                this.cacheManager.syncLocalCache(deviceId, workspaceFolder.uri.path, targetPath, validNames).catch(e => {
                    console.error("Cache sync failed:", e);
                });
            }
        }
        
        return entries;
    }


    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        
        // 1. Check existence and read permissions
        const checkCmd = `if [ -e "${targetPath}" ]; then if [ -r "${targetPath}" ]; then echo "OK"; else echo "NO_READ"; fi; else echo "NOT_FOUND"; fi`;
        const checkOutput = (await shell.executeCommand(checkCmd)).trim();
        
        if (checkOutput === "NOT_FOUND" || checkOutput === "NO_READ") {
            // Try to find if it's in cache and delete it
            const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
            if (workspaceFolder) {
                const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceFolder.uri.path);
                const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
                const cachedFilePath = path.join(cacheDir, relativePath);
                if (fs.existsSync(cachedFilePath)) {
                    fs.unlinkSync(cachedFilePath);
                }
            }
            
            throw checkOutput === "NOT_FOUND" ? vscode.FileSystemError.FileNotFound(uri) : vscode.FileSystemError.NoPermissions(uri);
        }
        
        // 2. Resolve workspace folder to use cache
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
        
        if (workspaceFolder) {
            const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceFolder.uri.path);
            const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
            const cachedFilePath = path.join(cacheDir, relativePath);
            
            // Check if it exists in cache
            if (!fs.existsSync(cachedFilePath)) {
                // Not in cache, pull using tar
                await this.cacheManager.pullFileToCache(deviceId, workspaceFolder.uri.path, relativePath);
            }
            
            if (fs.existsSync(cachedFilePath)) {
                return await fs.promises.readFile(cachedFilePath);
            }
        }
        
        // 3. Fallback to ADB pull if not in workspace or tar failed to produce the file
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
