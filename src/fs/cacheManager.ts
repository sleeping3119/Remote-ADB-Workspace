import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as tar from 'tar';
import { spawn } from 'child_process';
import { Logger } from '../logger';
import { ConnectionManager } from '../adb/connectionManager';
import { ToyboxManager } from '../adb/toyboxManager';

export class CacheManager {
    private cacheRoot: string;
    
    constructor(private context: vscode.ExtensionContext, private connectionManager: ConnectionManager, private toyboxManager: ToyboxManager) {
        // Use workspace storage if available, otherwise fallback to global storage
        this.cacheRoot = context.storageUri ? context.storageUri.fsPath : path.join(context.globalStorageUri.fsPath, 'workspace-cache');
    }

    public getCacheDir(deviceId: string, workspaceRoot: string): string {
        const sanitizedDeviceId = deviceId.replace(/[/\\:*?"<>|]/g, '_');
        const sanitizedRoot = workspaceRoot.replace(/[/\\:*?"<>|]/g, '_');
        return path.join(this.cacheRoot, sanitizedDeviceId, sanitizedRoot);
    }

    public async initializeCache(deviceId: string, workspaceRoot: string): Promise<void> {
        const stateKey = `cache_initialized_${deviceId}_${workspaceRoot}`;
        
        if (this.context.workspaceState.get(stateKey)) {
            Logger.logOutput(`[CacheManager] Cache already initialized for ${workspaceRoot}`);
            return;
        }

        Logger.logOutput(`[CacheManager] Initializing cache for ${workspaceRoot}...`);
        
        const cacheDir = this.getCacheDir(deviceId, workspaceRoot);
        Logger.logOutput(`[CacheManager] Local cache mirror target path: ${cacheDir}`);
        
        // Ensure cache dir exists and is empty
        if (fs.existsSync(cacheDir)) {
            await fs.promises.rm(cacheDir, { recursive: true, force: true });
        }
        await fs.promises.mkdir(cacheDir, { recursive: true });

        const adbPath = await this.connectionManager.toolsManager.getAdbPath();
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const rawFolder = this.toyboxManager.getRawFolderPath(deviceId, currentUser.name);
        
        const runId = `tar_${Date.now()}`;
        const statusFile = `${rawFolder}/.${runId}_status`;
        const errorFile = `${rawFolder}/.${runId}_errors`;
        
        Logger.logOutput(`[CacheManager] Estimating total files for progress tracking...`);
        let totalFiles = 0;
        try {
            const findOutput = await shell.executeCommand(`cd "${workspaceRoot}" && toybox find . 2>/dev/null | toybox wc -l`);
            totalFiles = parseInt(findOutput.trim(), 10);
            if (isNaN(totalFiles)) totalFiles = 0;
        } catch (e) {
            Logger.logOutput(`[CacheManager] Failed to estimate total files: ${e}`);
        }
        
        const shellCmd = `
mkdir -p "${rawFolder}" 2>/dev/null
cd "${workspaceRoot}" || { printf 'FATAL_CD\\n' > "${statusFile}"; exit 100; }
rm -f "${statusFile}" "${errorFile}"
toybox tar chf - . 2>"${errorFile}"
tar_status=$?
printf 'COMPLETE\\nEXIT=%s\\n' "$tar_status" > "${statusFile}"
exit "$tar_status"
`.trim();
        
        const fullAdbCommand = `"${adbPath}" -s ${deviceId} exec-out '${shellCmd}'`;
        Logger.logCommand(`[CacheManager] Executing background cache shell command: ${shellCmd}`);
        Logger.logCommand(`[CacheManager] Full subprocess command: ${fullAdbCommand}`);
        
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Caching Remote Workspace",
            cancellable: true
        }, (progress, token) => {
            return new Promise<void>((resolve, reject) => {
                const adbProc = spawn(adbPath, ['-s', deviceId, 'exec-out', shellCmd], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let extractedCount = 0;
                let lastReportTime = Date.now();
                let reportedPercent = 0;
                
                const extractStream = tar.extract({ 
                    cwd: cacheDir,
                    onentry: (entry) => {
                        extractedCount++;
                        const now = Date.now();
                        
                        if (now - lastReportTime > 200 || extractedCount === totalFiles) {
                            if (totalFiles > 0) {
                                // Cap at 100% just in case file count changed during execution
                                const percent = Math.min(100, Math.floor((extractedCount / totalFiles) * 100));
                                const increment = percent - reportedPercent;
                                reportedPercent = percent;
                                
                                progress.report({ 
                                    message: `${percent}% (${extractedCount}/${totalFiles})`,
                                    increment: increment > 0 ? increment : undefined
                                });
                            } else {
                                progress.report({ 
                                    message: `Extracted ${extractedCount} files...`
                                });
                            }
                            lastReportTime = now;
                        }
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
                
                adbProc.on('close', async (adbExitCode) => {
                    try {
                        const shell = await this.connectionManager.getPersistentShell(deviceId);
                        
                        // Read both status and error files
                        const statusOutput = await shell.executeCommand(`cat "${statusFile}" 2>/dev/null`);
                        const errorOutput = await shell.executeCommand(`cat "${errorFile}" 2>/dev/null`);
                        
                        // Clean up temp files
                        await shell.executeCommand(`rm -f "${statusFile}" "${errorFile}"`);
                        
                        const statusLines = statusOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                        
                        if (statusLines.includes('FATAL_CD')) {
                            Logger.logError(`[CacheManager] FATAL: could not cd into "${workspaceRoot}" on device.`);
                            this.context.workspaceState.update(stateKey, false);
                            await fs.promises.rm(cacheDir, { recursive: true, force: true });
                            reject(new Error(`Failed to access workspace root ${workspaceRoot}`));
                            return;
                        }
                        
                        const completed = statusLines.includes('COMPLETE');
                        const exitLine = statusLines.find(l => l.startsWith('EXIT='));
                        const remoteTarExitCode = exitLine ? parseInt(exitLine.slice('EXIT='.length), 10) : null;
                        
                        if (!completed) {
                            Logger.logError(`[CacheManager] FATAL: remote command did not reach completion. ADB exit code: ${adbExitCode}`);
                            if (errorOutput.trim()) {
                                Logger.logError(`[CacheManager] Errors captured before failure:\n${errorOutput}`);
                            }
                            this.context.workspaceState.update(stateKey, false);
                            await fs.promises.rm(cacheDir, { recursive: true, force: true });
                            reject(new Error(`Remote tar command abruptly failed (adb code ${adbExitCode})`));
                            return;
                        }
                        
                        const skippedEntries: { file: string, reason: string }[] = [];
                        const otherErrors: string[] = [];
                        
                        for (const line of errorOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
                            const match = line.match(/^tar:\s+(.+?):\s+(.+)$/);
                            if (match) {
                                skippedEntries.push({ file: match[1], reason: match[2] });
                            } else {
                                otherErrors.push(line);
                            }
                        }
                        
                        // Save skipped entries to workspaceState for transparency
                        const skippedKey = `cache_skipped_${deviceId}_${workspaceRoot}`;
                        this.context.workspaceState.update(skippedKey, skippedEntries);
                        
                        if (remoteTarExitCode === 0) {
                            Logger.logOutput(`[CacheManager] Remote tar completed successfully.`);
                            this.context.workspaceState.update(stateKey, true);
                            resolve();
                        } else if (skippedEntries.length > 0) {
                            Logger.logOutput(`[CacheManager] Remote tar completed with ${skippedEntries.length} skipped entries:`);
                            skippedEntries.forEach(entry => {
                                Logger.logOutput(`  - Skipped: ${entry.file} (Reason: ${entry.reason})`);
                            });
                            
                            if (otherErrors.length > 0) {
                                Logger.logError(`[CacheManager] Unattributed tar errors:\n${otherErrors.join('\n')}`);
                            }
                            // Still mark as successful because we got the bulk of the files
                            this.context.workspaceState.update(stateKey, true);
                            resolve();
                        } else {
                            Logger.logError(`[CacheManager] Remote tar failed with exit code ${remoteTarExitCode}. Unattributed errors:\n${otherErrors.join('\n')}`);
                            this.context.workspaceState.update(stateKey, false);
                            await fs.promises.rm(cacheDir, { recursive: true, force: true });
                            reject(new Error(`Remote tar failed with code ${remoteTarExitCode}`));
                        }
                    } catch (e) {
                        Logger.logError(`[CacheManager] Failed to retrieve remote tar status: ${e}`);
                        this.context.workspaceState.update(stateKey, false);
                        await fs.promises.rm(cacheDir, { recursive: true, force: true });
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
