import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as tar from 'tar';
import { spawn } from 'child_process';
import { Logger } from '../logger';
import { ConnectionManager } from '../adb/connectionManager';

export class CacheManager {
    private cacheRoot: string;
    
    constructor(private context: vscode.ExtensionContext, private connectionManager: ConnectionManager) {
        // Use workspace storage if available, otherwise fallback to global storage
        this.cacheRoot = context.storageUri ? context.storageUri.fsPath : path.join(context.globalStorageUri.fsPath, 'workspace-cache');
    }

    public getCacheDir(deviceId: string, workspaceRoot: string): string {
        const sanitizedDeviceId = deviceId.replace(/[/\\:*?"<>|]/g, '_');
        const sanitizedRoot = workspaceRoot.replace(/[/\\:*?"<>|]/g, '_');
        return path.join(this.cacheRoot, sanitizedDeviceId, sanitizedRoot);
    }

    public async initializeCache(deviceId: string, manifest: any): Promise<void> {
        const workspaceRoot = manifest.workspaceRoot;
        const stateKey = `cache_initialized_${deviceId}_${workspaceRoot}`;
        
        if (this.context.workspaceState.get(stateKey)) {
            Logger.logOutput(`[CacheManager] Cache already initialized for ${workspaceRoot}`);
            return;
        }

        Logger.logOutput(`[CacheManager] Initializing cache for ${workspaceRoot}...`);
        
        // Ensure cache dir exists
        const cacheDir = this.getCacheDir(deviceId, workspaceRoot);
        Logger.logOutput(`[CacheManager] Local cache mirror target path: ${cacheDir}`);
        
        if (!fs.existsSync(cacheDir)) {
            await fs.promises.mkdir(cacheDir, { recursive: true });
        }

        // Combine fullAccess and readOnly files for caching
        const allFiles: string[] = [
            ...(manifest.fullAccess || []),
            ...(manifest.readOnly || [])
        ];

        if (allFiles.length === 0) {
            Logger.logOutput(`[CacheManager] No files to cache.`);
            return;
        }

        const relativeFiles = allFiles
            .filter(f => f !== workspaceRoot && f.startsWith(workspaceRoot))
            .map(f => {
                let rel = f.substring(workspaceRoot.length);
                if (rel.startsWith('/')) rel = rel.substring(1);
                return rel;
            })
            .filter(f => f.length > 0);

        if (relativeFiles.length === 0) {
            return;
        }

        const filesString = relativeFiles.map(f => `"${f}"`).join(' ');
        const adbPath = await this.connectionManager.toolsManager.getAdbPath();
        
        const statusFile = `/data/local/tmp/.tar_status_${Date.now()}`;
        const shellCmd = `cd "${workspaceRoot}" && toybox tar chf - ${filesString}; echo $? > "${statusFile}"`;
        
        const fullAdbCommand = `"${adbPath}" -s ${deviceId} exec-out '${shellCmd}'`;
        Logger.logCommand(`[CacheManager] Executing background cache shell command: ${shellCmd}`);
        Logger.logCommand(`[CacheManager] Full subprocess command: ${fullAdbCommand}`);
        
        const totalFiles = relativeFiles.length;
        
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Caching Remote Workspace",
            cancellable: true
        }, (progress, token) => {
            return new Promise<void>((resolve, reject) => {
                const adbProc = spawn(adbPath, ['-s', deviceId, 'exec-out', shellCmd]);
                
                let extractedCount = 0;
                
                const extractStream = tar.extract({ 
                    cwd: cacheDir,
                    onentry: (entry) => {
                        extractedCount++;
                        const percent = Math.round((extractedCount / totalFiles) * 100);
                        progress.report({ 
                            message: `${percent}% (${extractedCount}/${totalFiles})`,
                            increment: (1 / totalFiles) * 100
                        });
                    }
                });
                
                token.onCancellationRequested(() => {
                    Logger.logOutput(`[CacheManager] Caching cancelled by user.`);
                    adbProc.kill();
                    this.context.workspaceState.update(stateKey, false);
                    reject(new Error("Cancelled"));
                });
                
                adbProc.stdout.pipe(extractStream);
                
                let stderr = '';
                adbProc.stderr.on('data', (data) => stderr += data.toString());
                
                let streamFinished = false;
                extractStream.on('finish', () => {
                    Logger.logOutput(`[CacheManager] Cache extraction stream finished.`);
                    streamFinished = true;
                });
                
                extractStream.on('error', (err) => {
                    Logger.logError(`[CacheManager] Tar extraction error: ${err.message}`);
                    this.context.workspaceState.update(stateKey, false);
                    reject(err);
                });
                
                adbProc.on('close', async () => {
                    try {
                        const shell = await this.connectionManager.getPersistentShell(deviceId);
                        const statusOutput = await shell.executeCommand(`cat "${statusFile}"; rm "${statusFile}"`);
                        const statusCode = parseInt(statusOutput.trim(), 10);
                        
                        if (isNaN(statusCode) || statusCode !== 0) {
                            Logger.logError(`[CacheManager] Remote tar failed with status code: ${statusOutput.trim()} (stderr: ${stderr})`);
                            this.context.workspaceState.update(stateKey, false);
                            reject(new Error(`Remote tar failed with code ${statusCode}`));
                        } else {
                            // Mark as successfully initialized
                            Logger.logOutput(`[CacheManager] Remote tar completed successfully.`);
                            this.context.workspaceState.update(stateKey, true);
                            resolve();
                        }
                    } catch (e) {
                        Logger.logError(`[CacheManager] Failed to retrieve remote tar status: ${e}`);
                        this.context.workspaceState.update(stateKey, false);
                        reject(e);
                    }
                });
            });
        });
    }

    public async syncLocalCache(deviceId: string, workspaceRoot: string, remotePath: string, validRemoteEntries: string[]) {
        const relPath = remotePath.startsWith(workspaceRoot) ? remotePath.substring(workspaceRoot.length) : '';
        const localPath = path.join(this.getCacheDir(deviceId, workspaceRoot), relPath);
        
        if (!fs.existsSync(localPath)) return;
        
        const localEntries = await fs.promises.readdir(localPath);
        const validSet = new Set(validRemoteEntries);
        
        for (const localEntry of localEntries) {
            if (!validSet.has(localEntry)) {
                const fullPath = path.join(localPath, localEntry);
                Logger.logOutput(`[CacheManager] Deleting local cache file not found on remote: ${fullPath}`);
                try {
                    await fs.promises.rm(fullPath, { recursive: true, force: true });
                } catch (e) {
                    Logger.logError(`[CacheManager] Failed to delete ${fullPath}: ${e}`);
                }
            }
        }
    }
}
