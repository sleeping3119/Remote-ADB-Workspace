import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ConnectionManager } from '../adb/connectionManager';
import { ToyboxManager } from '../adb/toyboxManager';
import { CacheManager } from './cacheManager';
import { escapePath } from '../utils/shellUtils';

export interface AdbDirEntry {
    name: string;
    type: vscode.FileType;
    accessible: boolean;
}

export class AdbFileSystemProvider implements vscode.FileSystemProvider {
    private connectionManager: ConnectionManager;
    private toyboxManager: ToyboxManager;
    private cacheManager: CacheManager;
    
    // Negative cache to store paths that do not exist on the device, with a TTL timestamp
    private negativeStatCache = new Map<string, number>();
    private readonly NEGATIVE_CACHE_TTL_MS = 10000; // 10 seconds
    
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
        const uriStr = uri.toString();
        const now = Date.now();
        if (this.negativeStatCache.has(uriStr)) {
            if (now - this.negativeStatCache.get(uriStr)! < this.NEGATIVE_CACHE_TTL_MS) {
                throw vscode.FileSystemError.FileNotFound(uri);
            } else {
                this.negativeStatCache.delete(uriStr);
            }
        }

        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        const safePath = escapePath(targetPath);
        // Using native shell to check write permission and directory status, then toybox stat
        const shellCmd = `if [ -w "${safePath}" ]; then echo "W"; else echo "NW"; fi; if [ -d "${safePath}" ]; then echo "D"; else echo "ND"; fi; ${prefix} stat -c "%f %s %Y" "${safePath}" 2>/dev/null`;
        const output = await shell.executeCommand(shellCmd);
        
        const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        
        if (lines.length < 3 || lines[2].includes('No such file') || lines[2].includes('stat: ')) {
            this.negativeStatCache.set(uriStr, Date.now());
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        
        const writeStatus = lines[0];
        const dirStatus = lines[1];
        const parts = lines[2].split(' ');
        if (parts.length < 3) {
            this.negativeStatCache.set(uriStr, Date.now());
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        
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
        
        const safePath = escapePath(targetPath);
        // Native shell tests to resolve symlinks and check permissions. 
        // Folders must have r_x, files must have r__. We append |1 for symlinks or |0 for normal files.
        const shellCmd = `cd "${safePath}" 2>/dev/null && ls -1A | while IFS= read -r f; do is_sym="0"; [ -L "$f" ] && is_sym="1"; if [ -d "$f" ]; then [ -r "$f" ] && [ -x "$f" ] && printf "%s/|%s\\n" "$f" "$is_sym"; elif [ -f "$f" ]; then [ -r "$f" ] && printf "%s|%s\\n" "$f" "$is_sym"; fi; done`;
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
        
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);

        const uriStr = uri.toString();
        const now = Date.now();
        if (this.negativeStatCache.has(uriStr)) {
            if (now - this.negativeStatCache.get(uriStr)! < this.NEGATIVE_CACHE_TTL_MS) {
                throw vscode.FileSystemError.FileNotFound(uri);
            } else {
                this.negativeStatCache.delete(uriStr);
            }
        }

        const safePath = escapePath(targetPath);
        // 1. Check existence and read permissions, and fetch remote mtime/size
        const checkCmd = `if [ -e "${safePath}" ]; then if [ -r "${safePath}" ]; then ${prefix} stat -c "OK|%Y|%s" "${safePath}"; else echo "NO_READ"; fi; else echo "NOT_FOUND"; fi`;
        const checkOutput = (await shell.executeCommand(checkCmd)).trim();
        
        const outputLines = checkOutput.split(/\r?\n/).filter(Boolean);
        const lastLine = outputLines[outputLines.length - 1] || "NOT_FOUND";

        if (lastLine === "NOT_FOUND" || lastLine === "NO_READ") {
            // Try to find if it's in cache and delete it
            const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
            if (workspaceFolder) {
                const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceFolder.uri.path);
                const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
                const cachedFilePath = path.join(cacheDir, relativePath);
                if (fs.existsSync(cachedFilePath)) {
                    fs.unlinkSync(cachedFilePath);
                }
                this.cacheManager.removeBaseline(deviceId, workspaceFolder.uri.path, relativePath);
            }
            
            if (lastLine === "NOT_FOUND") {
                this.negativeStatCache.set(uriStr, Date.now());
                throw vscode.FileSystemError.FileNotFound(uri);
            } else {
                throw vscode.FileSystemError.NoPermissions(uri);
            }
        }
        
        // 2. Resolve workspace folder to use cache
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
        
        if (!workspaceFolder) {
            // Standalone file opened via file picker (not part of workspace)
            // It might require root privileges to read (if user switched to root), 
            // so we must copy it to a world-readable tmp directory first using the persistent shell!
            const rawFolder = await this.toyboxManager.getRawFolderPath(deviceId, 'shell');
            const tempRawFileName = 'pull_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            const safeTempRawPath = escapePath(path.posix.join(rawFolder, tempRawFileName));
            
            // Use the persistent shell to copy the file to the temp path and make it readable for adb pull
            const cpCmd = `cp "${safePath}" "${safeTempRawPath}" && chmod 666 "${safeTempRawPath}" 2>&1 && echo "OK" || echo "ERR:$?"`;
            const cpOutput = (await shell.executeCommand(cpCmd)).trim();
            if (!cpOutput.endsWith("OK")) {
                throw vscode.FileSystemError.Unavailable(`Failed to stage file for reading: ${cpOutput.replace('ERR', '').trim()}`);
            }

            const crypto = require('crypto');
            const os = require('os');
            const tempFilePath = path.join(os.tmpdir(), `adb_temp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
            const safeTempFile = escapePath(tempFilePath);
            try {
                await this.connectionManager.executeCommandForDevice(deviceId, `pull "${safeTempRawPath}" "${safeTempFile}"`);
                const content = await fs.promises.readFile(tempFilePath);
                return content;
            } finally {
                if (fs.existsSync(tempFilePath)) {
                    await fs.promises.unlink(tempFilePath).catch(() => {});
                }
                // Cleanup remote temp file using adb shell directly (runs as shell)
                await this.connectionManager.executeCommandForDevice(deviceId, `shell rm -f "${safeTempRawPath}"`).catch(() => {});
            }
        }

        const workspaceRoot = workspaceFolder.uri.path;
        const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceRoot);
        const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
        const cachedFilePath = path.join(cacheDir, relativePath);

        const parts = lastLine.split('|');
        if (parts[0] === 'OK' && parts.length === 3) {
            // stat "%Y" is epoch seconds. Cache mtime is stored from local stat, which is epoch ms, 
            // but we can just normalize both to seconds for comparison to be safe, or just compare roughly.
            // Wait, we stored `Math.floor(stat.mtimeMs)` in cacheManager. Let's compare seconds.
            const remoteMtimeSecs = parseInt(parts[1], 10);
            const remoteSize = parseInt(parts[2], 10);
            
            let baseline = this.cacheManager.getBaseline(deviceId, workspaceRoot, relativePath);
            
            // Lazily establish baseline if the file was populated by initializeCache (tar)
            if (!baseline && fs.existsSync(cachedFilePath)) {
                const localStat = await fs.promises.stat(cachedFilePath);
                const localMtimeSecs = Math.floor(localStat.mtimeMs / 1000);
                
                if (localMtimeSecs === remoteMtimeSecs && localStat.size === remoteSize) {
                    const content = await fs.promises.readFile(cachedFilePath);
                    const hash = crypto.createHash('md5').update(content).digest('hex');
                    baseline = {
                        md5: hash,
                        mtime: Math.floor(localStat.mtimeMs),
                        size: localStat.size
                    };
                    this.cacheManager.updateBaseline(deviceId, workspaceRoot, relativePath, baseline);
                }
            }

            if (baseline) {
                const baselineMtimeSecs = Math.floor(baseline.mtime / 1000);
                // Due to local extraction, mtime might be slightly off. Actually, Android filesystem 
                // might have different resolution. We primarily care about size or significant mtime changes.
                // It's safest to invalidate if they don't match, as pulling is cheap.
                if (baselineMtimeSecs !== remoteMtimeSecs || baseline.size !== remoteSize) {
                    if (fs.existsSync(cachedFilePath)) {
                        fs.unlinkSync(cachedFilePath);
                    }
                    this.cacheManager.removeBaseline(deviceId, workspaceRoot, relativePath);
                }
            } else if (fs.existsSync(cachedFilePath)) {
                // No baseline and local stat didn't match remote stat, it means it changed 
                // remotely after initializeCache extracted it. It's stale!
                fs.unlinkSync(cachedFilePath);
            }
        }

        // Check if it exists in cache
        if (!fs.existsSync(cachedFilePath)) {
            // Not in cache, pull using tar
            await this.cacheManager.pullFileToCache(deviceId, workspaceFolder.uri.path, relativePath);
        }
        
        if (fs.existsSync(cachedFilePath)) {
            return await fs.promises.readFile(cachedFilePath);
        }
        
        // 3. If file still doesn't exist, it failed to extract (e.g. illegal windows characters like ':')
        throw vscode.FileSystemError.Unavailable(`Cannot read file from device. (It might contain illegal characters for Windows, e.g., ':', or cannot be accessed.)`);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
        this.negativeStatCache.delete(uri.toString());
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        
        const safeTargetPath = escapePath(targetPath);
        
        // Atomic creation step
        if (options.create) {
            const parentPath = path.posix.dirname(targetPath);
            const safeParentPath = escapePath(parentPath);
            // Only check parent write permissions and touch if the file doesn't already exist.
            const cmd = `if [ -e "${safeTargetPath}" ]; then echo "EXISTS"; elif [ ! -w "${safeParentPath}" ]; then echo "NO_WRITE"; else touch "${safeTargetPath}" 2>&1 && echo "OK" || echo "ERR:$?"; fi`;
            const output = (await shell.executeCommand(cmd)).trim();
            
            if (output.startsWith("NO_WRITE")) {
                throw vscode.FileSystemError.NoPermissions(`'${path.posix.basename(parentPath)}' folder has no write permission. You can only modify existing files in it.`);
            }
            
            if (!output.endsWith("OK") && !output.endsWith("EXISTS")) {
                throw vscode.FileSystemError.Unavailable(`Failed to create file: ${output.replace('ERR', '').trim()}`);
            }
            
            if (output.endsWith("OK")) {
                // Sync structure using tar immediately before any reads can happen
                const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
                if (workspaceFolder) {
                    const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
                    await this.cacheManager.pullFileToCache(deviceId, workspaceFolder.uri.path, relativePath);
                }
                
                this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
            }
        }
        
        // Resolve cache file path
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
        
        // Calculate local hash of the new content being saved
        const localHash = crypto.createHash('md5').update(content).digest('hex');

        // OPTIMISTIC CONCURRENCY CONTROL (workspace only)
        if (!options.create && workspaceFolder) {
            const workspaceRoot = workspaceFolder.uri.path;
            const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
            const baseline = this.cacheManager.getBaseline(deviceId, workspaceRoot, relativePath);
            if (baseline) {
                const currentUser = await shell.getCurrentUser();
                const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
                
                const md5Cmd = `if [ -f "${safeTargetPath}" ]; then ${prefix} md5sum "${safeTargetPath}" | cut -d' ' -f1; else echo "NOT_FOUND"; fi`;
                const remoteHashOutput = (await shell.executeCommand(md5Cmd)).trim().split(/\r?\n/).pop() || "NOT_FOUND";
                
                if (remoteHashOutput !== "NOT_FOUND" && remoteHashOutput !== baseline.md5) {
                    if (localHash !== baseline.md5) {
                        const choice = await vscode.window.showWarningMessage(
                            "The file on your Android device was modified while you also had changes on your computer.\n\nYou have two options:\n\n1. **Sync from Android** — your local changes on the computer will be lost and replaced with the newer file from the device.\n2. **Force your changes to Android** — your computer's version will overwrite the current file on the device.\n\nChoose carefully, because one version will replace the other.",
                            { modal: true },
                            "Sync from Android",
                            "Force your changes to Android"
                        );

                        if (choice === "Sync from Android") {
                            await this.cacheManager.pullFileToCache(deviceId, workspaceRoot, relativePath);
                            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                            throw vscode.FileSystemError.Unavailable("Save aborted: synced from Android.");
                        } else if (choice === "Force your changes to Android") {
                            // Proceed to save
                        } else {
                            throw vscode.FileSystemError.Unavailable("Save cancelled due to conflict.");
                        }
                    } else {
                        // Safe re-pull
                        await this.cacheManager.pullFileToCache(deviceId, workspaceRoot, relativePath);
                        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                        throw vscode.FileSystemError.Unavailable("Save aborted: remote was newer, file reloaded.");
                    }
                }
            }
        }
        
        try {
            if (content.byteLength > 0 || !options.create) {
                let localFileToPush: string;
                let tempFilePathToCleanup: string | undefined;

                if (workspaceFolder) {
                    const workspaceRoot = workspaceFolder.uri.path;
                    const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
                    const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceRoot);
                    const cachedFilePath = path.join(cacheDir, relativePath);
                    
                    await fs.promises.mkdir(path.dirname(cachedFilePath), { recursive: true });
                    await fs.promises.writeFile(cachedFilePath, content);
                    localFileToPush = cachedFilePath;
                } else {
                    const crypto = require('crypto');
                    const os = require('os');
                    const tempFilePath = path.join(os.tmpdir(), `adb_temp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
                    await fs.promises.writeFile(tempFilePath, content);
                    localFileToPush = tempFilePath;
                    tempFilePathToCleanup = tempFilePath;
                }

                // Push to .raw folder first, then cat into targetPath to follow symlinks safely
                const rawFolder = await this.toyboxManager.getRawFolderPath(deviceId, 'shell');
                const tempRawFileName = 'push_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                const tempRawPath = path.posix.join(rawFolder, tempRawFileName);
                
                const safeLocalFile = escapePath(localFileToPush);
                const safeTempRawPath = escapePath(tempRawPath);
                
                await this.connectionManager.executeCommandForDevice(deviceId, `push "${safeLocalFile}" "${safeTempRawPath}"`);
                
                const catCmd = `cat "${safeTempRawPath}" > "${safeTargetPath}" 2>&1 && echo "OK" || echo "ERR:$?"`;
                const catOutput = (await shell.executeCommand(catCmd)).trim();
                
                await this.connectionManager.executeCommandForDevice(deviceId, `shell rm -f "${safeTempRawPath}"`).catch(() => {});
                
                if (tempFilePathToCleanup && fs.existsSync(tempFilePathToCleanup)) {
                    await fs.promises.unlink(tempFilePathToCleanup).catch(() => {});
                }

                if (!catOutput.endsWith("OK")) {
                    throw vscode.FileSystemError.Unavailable(`Failed to save file remotely: ${catOutput.replace('ERR', '').trim()}`);
                }
                
                // Update baseline after successful write
                if (workspaceFolder) {
                    const workspaceRoot = workspaceFolder.uri.path;
                    const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
                    const currentUser = await shell.getCurrentUser();
                    const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
                    const statCmd = `${prefix} stat -c "%Y %s" "${safeTargetPath}"`;
                    const statOutput = (await shell.executeCommand(statCmd)).trim().split(/\r?\n/).pop() || "";
                    const statParts = statOutput.split(' ');
                    if (statParts.length === 2) {
                        const newMtime = parseInt(statParts[0], 10) * 1000;
                        const newSize = parseInt(statParts[1], 10);
                        this.cacheManager.updateBaseline(deviceId, workspaceRoot, relativePath, {
                            md5: localHash,
                            mtime: newMtime,
                            size: newSize
                        });
                    }
                }
                
                this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            }
        } catch (e: any) {
            if (e instanceof vscode.FileSystemError) {
                throw e;
            }
            throw vscode.FileSystemError.Unavailable(uri);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        this.negativeStatCache.delete(uri.toString());
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        
        const parentPath = path.posix.dirname(targetPath);
        const safeTargetPath = escapePath(targetPath);
        const safeParentPath = escapePath(parentPath);
        const cmd = `if [ ! -w "${safeParentPath}" ]; then echo "NO_WRITE"; else mkdir -p "${safeTargetPath}" 2>&1 && echo "OK" || echo "ERR:$?"; fi`;
        const output = (await shell.executeCommand(cmd)).trim();
        
        if (output.startsWith("NO_WRITE")) {
            throw vscode.FileSystemError.NoPermissions(`'${path.posix.basename(parentPath)}' folder has no write permission. You can only modify existing files in it.`);
        }
        
        if (!output.endsWith("OK")) {
            throw vscode.FileSystemError.Unavailable(`Failed to create folder: ${output.replace('ERR', '').trim()}`);
        }
        
        // Atomic local cache structure update
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
        if (workspaceFolder) {
            const relativePath = targetPath.substring(workspaceFolder.uri.path.length).replace(/^\/+/, '');
            await this.cacheManager.pullFileToCache(deviceId, workspaceFolder.uri.path, relativePath);
        }
        
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        await this.connectionManager.waitForShellReady();
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        const parentPath = path.posix.dirname(targetPath);
        const rmArgs = options.recursive ? '-rf' : '-f';
        const safeTargetPath = escapePath(targetPath);
        const safeParentPath = escapePath(parentPath);
        const cmd = `if [ ! -w "${safeParentPath}" ]; then echo "NO_WRITE"; else ${prefix} rm ${rmArgs} "${safeTargetPath}" 2>&1 && echo "OK" || echo "ERR:$?"; fi`;
        const output = (await shell.executeCommand(cmd)).trim();
        
        if (output.startsWith("NO_WRITE")) {
            throw vscode.FileSystemError.NoPermissions(`'${path.posix.basename(parentPath)}' folder has no write permission.`);
        }
        
        if (!output.endsWith("OK")) {
            throw vscode.FileSystemError.Unavailable(`Failed to delete: ${output.replace('ERR', '').trim()}`);
        }
        
        // Remove from local cache
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => targetPath.startsWith(f.uri.path));
        if (workspaceFolder) {
            const workspaceRoot = workspaceFolder.uri.path;
            const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceRoot);
            const relativePath = targetPath.substring(workspaceRoot.length).replace(/^\/+/, '');
            const cachedFilePath = path.join(cacheDir, relativePath);
            
            if (fs.existsSync(cachedFilePath)) {
                try {
                    await fs.promises.rm(cachedFilePath, { recursive: true, force: true });
                } catch (e) {
                    console.error(`Failed to delete local cache at ${cachedFilePath}: ${e}`);
                }
            }
            // Remove baseline for file or all child files if directory
            if (options.recursive) {
                // If we need to remove a whole directory's baselines, we'd need a clear method,
                // but for v1 simply removing the specific path handles files.
                // A full directory deletion might leave orphaned manifest entries,
                // which get cleaned up during syncLocalCache anyway.
            }
            this.cacheManager.removeBaseline(deviceId, workspaceRoot, relativePath);
        }
        
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
        
        const oldParentPath = path.posix.dirname(oldPath);
        const newParentPath = path.posix.dirname(newPath);
        
        const safeOldPath = escapePath(oldPath);
        const safeNewPath = escapePath(newPath);
        const safeOldParent = escapePath(oldParentPath);
        const safeNewParent = escapePath(newParentPath);

        // Check permissions on both the source parent and destination parent
        const cmd = `if [ ! -w "${safeOldParent}" ] || [ ! -w "${safeNewParent}" ]; then echo "NO_WRITE"; else ${prefix} mv "${safeOldPath}" "${safeNewPath}" 2>&1 && echo "OK" || echo "ERR:$?"; fi`;
        const output = (await shell.executeCommand(cmd)).trim();
        
        if (output.startsWith("NO_WRITE")) {
            throw vscode.FileSystemError.NoPermissions(`Missing write permission in source or destination directory.`);
        }
        
        if (!output.endsWith("OK")) {
            throw vscode.FileSystemError.Unavailable(`Failed to rename: ${output.replace('ERR', '').trim()}`);
        }

        // Move in local cache
        const workspaceFolderOld = vscode.workspace.workspaceFolders?.find(f => oldPath.startsWith(f.uri.path));
        const workspaceFolderNew = vscode.workspace.workspaceFolders?.find(f => newPath.startsWith(f.uri.path));
        
        if (workspaceFolderOld && workspaceFolderNew && workspaceFolderOld.uri.path === workspaceFolderNew.uri.path) {
            const workspaceRoot = workspaceFolderOld.uri.path;
            const cacheDir = this.cacheManager.getCacheDir(deviceId, workspaceRoot);
            const oldRelative = oldPath.substring(workspaceRoot.length).replace(/^\/+/, '');
            const newRelative = newPath.substring(workspaceRoot.length).replace(/^\/+/, '');
            const oldCachedFilePath = path.join(cacheDir, oldRelative);
            const newCachedFilePath = path.join(cacheDir, newRelative);
            
            if (fs.existsSync(oldCachedFilePath)) {
                try {
                    await fs.promises.mkdir(path.dirname(newCachedFilePath), { recursive: true });
                    await fs.promises.rename(oldCachedFilePath, newCachedFilePath);
                    
                    const oldBaseline = this.cacheManager.getBaseline(deviceId, workspaceRoot, oldRelative);
                    if (oldBaseline) {
                        this.cacheManager.updateBaseline(deviceId, workspaceRoot, newRelative, oldBaseline);
                        this.cacheManager.removeBaseline(deviceId, workspaceRoot, oldRelative);
                    }
                } catch (e) {
                    console.error(`Failed to move local cache from ${oldCachedFilePath} to ${newCachedFilePath}: ${e}`);
                }
            }
        }
        
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
        
        const safePath = escapePath(targetPath);
        // toybox ls -laL dereferences symlinks. We filter for directories 'd'
        const output = await shell.executeCommand(`${prefix} ls -laL "${safePath}" 2>/dev/null | ${prefix} grep '^d'`);
        
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
            
            const parts = trimmed.split(/\s+/);
            if (parts.length < 7) continue;
            
            const perms = parts[0];
            const owner = parts[2];
            const group = parts[3];
            
            let nameIndex = 7;
            if (parts[6] && !parts[6].includes(':') && !parts[5].includes(':')) {
            }
            for (let i = 4; i < parts.length; i++) {
                if (parts[i].includes(':')) {
                    nameIndex = i + 1;
                    break;
                }
            }
            
            let name = parts.slice(nameIndex).join(' ');
            
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

    private isAccessibleFilePicker(perms: string, owner: string, group: string, user: { name: string, groups: string[] }, isDir: boolean): boolean {
        if (user.name === 'root') return true;
        
        let rIndex = 7;
        let wIndex = 8;
        let xIndex = 9;
        
        if (user.name === owner) {
            rIndex = 1; wIndex = 2; xIndex = 3;
        } else if (user.groups.includes(group) || group === 'everybody') {
            rIndex = 4; wIndex = 5; xIndex = 6;
        }
        
        if (isDir) {
            return perms[rIndex] === 'r' && (perms[xIndex] === 'x' || perms[xIndex] === 's' || perms[xIndex] === 't');
        } else {
            return perms[rIndex] === 'r' && perms[wIndex] === 'w';
        }
    }

    public async readFilePickerDirectoryWithPermissions(uri: vscode.Uri): Promise<AdbDirEntry[]> {
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);
        
        const safePath = escapePath(targetPath);
        // toybox ls -laL dereferences symlinks. We filter for files '-', directories 'd' and broken symlinks 'l'
        const output = await shell.executeCommand(`${prefix} ls -laL "${safePath}" 2>/dev/null | ${prefix} grep '^[-dl]'`);
        
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
            
            const parts = trimmed.split(/\s+/);
            if (parts.length < 7) continue;
            
            const perms = parts[0];
            const owner = parts[2];
            const group = parts[3];
            
            let nameIndex = 7;
            if (parts[6] && !parts[6].includes(':') && !parts[5].includes(':')) {
            }
            for (let i = 4; i < parts.length; i++) {
                if (parts[i].includes(':')) {
                    nameIndex = i + 1;
                    break;
                }
            }
            
            let name = parts.slice(nameIndex).join(' ');
            
            if (perms[0] === 'l' && name.includes(' -> ')) {
                name = name.split(' -> ')[0];
            }
            
            if (name === '.' || name === '..' || name === '/' || name.includes('/')) continue;
            if (perms.includes('?')) continue;
            
            const isDir = perms[0] === 'd';
            const type = isDir ? vscode.FileType.Directory : (perms[0] === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File);
            const accessible = this.isAccessibleFilePicker(perms, owner, group, currentUser, isDir);
            
            entries.push({ name, type, accessible });
        }
        
        return entries;
    }

    public async isWorkspaceAccessible(uri: vscode.Uri): Promise<boolean> {
        const deviceId = await this.connectionManager.resolveDeviceId(uri.authority);
        const targetPath = uri.path;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        
        const safePath = escapePath(targetPath);
        // Use the shell builtin '[' instead of 'toybox test'. The shell builtin correctly 
        // evaluates Android MAC (SELinux) permissions, whereas the toybox binary often gives false positives.
        const output = await shell.executeCommand(`[ -d "${safePath}" ] && [ -r "${safePath}" ] && [ -x "${safePath}" ] && echo "OK"`);
        
        return output.trim() === 'OK';
    }
}
