import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as tar from 'tar';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { Logger } from '../logger';
import { ConnectionManager } from '../adb/connectionManager';
import { ToyboxManager } from '../adb/toyboxManager';
import { escapePath } from '../utils/shellUtils';
import { isInvalidWindowsPath } from '../utils/pathUtils';

export interface FileBaseline {
    md5: string;
    mtime: number;
    size: number;
}

export class CacheManager {
    private cacheRoot: string;
    private manifests: Map<string, Record<string, FileBaseline>> = new Map();

    
    constructor(private context: vscode.ExtensionContext, private connectionManager: ConnectionManager, private toyboxManager: ToyboxManager) {
        // Use workspace storage if available, otherwise fallback to global storage
        this.cacheRoot = context.storageUri ? context.storageUri.fsPath : path.join(context.globalStorageUri.fsPath, 'workspace-cache');
    }

    public getCacheDir(deviceId: string, workspaceRoot: string): string {
        // Strip trailing slash to ensure consistency between manifest paths and VS Code URI paths
        const normalizedRoot = workspaceRoot.replace(/\/+$/, '');
        const sanitizedDeviceId = deviceId.replace(/[/\\:*?"<>|]/g, '_');
        const sanitizedRoot = normalizedRoot.replace(/[/\\:*?"<>|]/g, '_');
        return path.join(this.cacheRoot, sanitizedDeviceId, sanitizedRoot);
    }

    private getManifestPath(deviceId: string, workspaceRoot: string): string {
        return path.join(this.getCacheDir(deviceId, workspaceRoot), '.manifest.json');
    }

    private loadManifest(deviceId: string, workspaceRoot: string): Record<string, FileBaseline> {
        const manifestPath = this.getManifestPath(deviceId, workspaceRoot);
        const key = `${deviceId}:${workspaceRoot}`;
        if (this.manifests.has(key)) {
            return this.manifests.get(key)!;
        }
        try {
            if (fs.existsSync(manifestPath)) {
                const data = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(data);
                this.manifests.set(key, manifest);
                return manifest;
            }
        } catch (e) {
            Logger.logError(`[CacheManager] Failed to load manifest: ${e}`);
        }
        const empty = {};
        this.manifests.set(key, empty);
        return empty;
    }

    private saveManifest(deviceId: string, workspaceRoot: string) {
        const manifestPath = this.getManifestPath(deviceId, workspaceRoot);
        const key = `${deviceId}:${workspaceRoot}`;
        const manifest = this.manifests.get(key) || {};
        try {
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        } catch (e) {
            Logger.logError(`[CacheManager] Failed to save manifest: ${e}`);
        }
    }

    public getBaseline(deviceId: string, workspaceRoot: string, relativePath: string): FileBaseline | undefined {
        const manifest = this.loadManifest(deviceId, workspaceRoot);
        return manifest[relativePath];
    }

    public updateBaseline(deviceId: string, workspaceRoot: string, relativePath: string, baseline: FileBaseline) {
        const manifest = this.loadManifest(deviceId, workspaceRoot);
        manifest[relativePath] = baseline;
        this.saveManifest(deviceId, workspaceRoot);
    }

    public removeBaseline(deviceId: string, workspaceRoot: string, relativePath: string) {
        const manifest = this.loadManifest(deviceId, workspaceRoot);
        if (manifest[relativePath]) {
            delete manifest[relativePath];
            this.saveManifest(deviceId, workspaceRoot);
        }
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
        const rawFolder = await this.toyboxManager.getRawFolderPath(deviceId, currentUser.name, shell);
        
        const runId = `tar_${Date.now()}`;
        const statusFile = `${rawFolder}/.${runId}_status`;
        const errorFile = `${rawFolder}/.${runId}_errors`;
        
        const safeWorkspaceRoot = escapePath(workspaceRoot);
        const safeStatusFile = escapePath(statusFile);
        const safeErrorFile = escapePath(errorFile);
        
        Logger.logOutput(`[CacheManager] Estimating total files for progress tracking...`);
        let totalFiles = 0;
        try {
            const findOutput = await shell.executeCommand(`cd "${safeWorkspaceRoot}" && toybox find . 2>/dev/null | toybox wc -l`);
            totalFiles = parseInt(findOutput.trim(), 10);
            if (isNaN(totalFiles)) totalFiles = 0;
        } catch (e) {
            Logger.logOutput(`[CacheManager] Failed to estimate total files: ${e}`);
        }
        
        const shellCmd = `
cd "${safeWorkspaceRoot}" || { printf 'FATAL_CD\\n' > "${safeStatusFile}"; exit 100; }
rm -f "${safeStatusFile}" "${safeErrorFile}"
toybox tar chf - . 2>"${safeErrorFile}"
tar_status=$?
printf 'COMPLETE\\nEXIT=%s\\n' "$tar_status" > "${safeStatusFile}"
exit "$tar_status"
`.trim();
        
        let execOutCmd = shellCmd;
        if (shell.activeSwitchCommand) {
            const escapedCmd = shellCmd.replace(/'/g, "'\\''");
            if (shell.activeSwitchCommand.type === 'termux' || shell.activeSwitchCommand.type === 'custom') {
                execOutCmd = `run-as ${shell.activeSwitchCommand.pkgName} sh -c '${escapedCmd}'`;
            } else if (shell.activeSwitchCommand.type === 'root') {
                execOutCmd = `su -c '${escapedCmd}'`;
            }
        }

        const fullAdbCommand = `"${adbPath}" -s ${deviceId} exec-out '${execOutCmd}'`;
        Logger.logCommand(`[CacheManager] Executing background cache shell command: ${execOutCmd}`);
        Logger.logCommand(`[CacheManager] Full subprocess command: ${fullAdbCommand}`);
        
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Caching Remote Workspace",
            cancellable: true
        }, (progress, token) => {
            return new Promise<void>((resolve, reject) => {
                const adbProc = spawn(adbPath, ['-s', deviceId, 'exec-out', execOutCmd], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let extractedCount = 0;
                let lastReportTime = Date.now();
                let reportedPercent = 0;
                let inFlightPath: string | null = null;
                
                const cleanupInFlight = () => {
                    if (inFlightPath && inFlightPath !== '.' && inFlightPath !== './') {
                        const suspectFile = path.join(cacheDir, inFlightPath);
                        Logger.logOutput(`[CacheManager] Cleaning up in-flight truncated file: ${suspectFile}`);
                        try {
                            if (fs.existsSync(suspectFile)) {
                                const stat = fs.statSync(suspectFile);
                                if (stat.isFile()) {
                                    fs.unlinkSync(suspectFile);
                                }
                            }
                        } catch (e) {
                            Logger.logError(`[CacheManager] Failed to remove in-flight file ${suspectFile}: ${e}`);
                        }
                        inFlightPath = null;
                    }
                };

                const notifyInterrupted = (reason: string) => {
                    vscode.window.showWarningMessage(
                        `Workspace cache initialization was ${reason}. On-demand file loading over ADB will be used, which may take extra time when opening files.`,
                        "Retry Cache Sync"
                    ).then(selection => {
                        if (selection === "Retry Cache Sync") {
                            this.context.workspaceState.update(stateKey, false);
                            this.initializeCache(deviceId, workspaceRoot).catch(e => {
                                Logger.logError(`[CacheManager] Retry cache initialization failed: ${e}`);
                            });
                        }
                    });
                };
                
                const windowsSkippedFiles: { file: string, reason: string }[] = [];
                const extractStream = tar.extract({ 
                    cwd: cacheDir,
                    onentry: (entry) => {
                        if (entry.type === 'File') {
                            inFlightPath = entry.path;
                            if (process.platform === 'win32') {
                                const check = isInvalidWindowsPath(entry.path);
                                if (check.invalid) {
                                    const reason = `Windows Invalid Path: ${check.reason}`;
                                    windowsSkippedFiles.push({ file: entry.path, reason });
                                    Logger.logWarning(`[CacheManager] Skipping invalid Windows path "${entry.path}": ${check.reason}`);
                                    vscode.window.showWarningMessage(`Skipping file invalid on Windows (${check.reason}): ${entry.path}`);
                                }
                            }
                        } else {
                            inFlightPath = null;
                        }
                        entry.on('end', () => {
                            if (inFlightPath === entry.path) {
                                inFlightPath = null;
                            }
                        });

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
                    cleanupInFlight();
                    adbProc.kill();
                    this.context.workspaceState.update(stateKey, false);
                    notifyInterrupted("cancelled");
                    reject(new Error("Cancelled"));
                });
                
                adbProc.stdout.pipe(extractStream);
                
                let stderr = '';
                adbProc.stderr.on('data', (data) => stderr += data.toString());
                
                let streamFinished = false;
                extractStream.on('finish', () => {
                    Logger.logOutput(`[CacheManager] Cache extraction stream finished.`);
                    inFlightPath = null;
                    streamFinished = true;
                });
                
                extractStream.on('warn', (code, message, data) => {
                    const fileInfo = data?.path || data?.file || 'unknown';
                    windowsSkippedFiles.push({ file: fileInfo, reason: `tar warning: ${message}` });
                    Logger.logWarning(`[CacheManager] Tar initialization warning on ${fileInfo} (Code: ${code}): ${message}`);
                    vscode.window.showWarningMessage(`Skipped cache file due to illegal Windows characters or extraction error: ${fileInfo}`);
                });
                
                extractStream.on('error', (err) => {
                    Logger.logError(`[CacheManager] Tar extraction error: ${err.message}`);
                    cleanupInFlight();
                    this.context.workspaceState.update(stateKey, false);
                    notifyInterrupted("interrupted due to an extraction error");
                    reject(err);
                });
                
                adbProc.on('close', async (adbExitCode) => {
                    try {
                        const shell = await this.connectionManager.getPersistentShell(deviceId);
                        
                        // Read both status and error files
                        const statusOutput = await shell.executeCommand(`cat "${safeStatusFile}" 2>/dev/null`);
                        const errorOutput = await shell.executeCommand(`cat "${safeErrorFile}" 2>/dev/null`);
                        
                        // Clean up temp files
                        await shell.executeCommand(`rm -f "${safeStatusFile}" "${safeErrorFile}"`);
                        
                        const statusLines = statusOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                        
                        if (statusLines.includes('FATAL_CD')) {
                            Logger.logError(`[CacheManager] FATAL: could not cd into "${workspaceRoot}" on device.`);
                            this.context.workspaceState.update(stateKey, false);
                            cleanupInFlight();
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
                            cleanupInFlight();
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
                        
                        // Combine remote and local skipped files
                        skippedEntries.push(...windowsSkippedFiles);
                        
                        // Save skipped entries to workspaceState for transparency
                        const skippedKey = `cache_skipped_${deviceId}_${workspaceRoot}`;
                        this.context.workspaceState.update(skippedKey, skippedEntries);
                        
                        if (remoteTarExitCode === 0 && skippedEntries.length === 0) {
                            Logger.logOutput(`[CacheManager] Summary: Cache initialization completed successfully. All files were transferred with 0 files skipped.`);
                            this.context.workspaceState.update(stateKey, true);
                            resolve();
                        } else if (remoteTarExitCode === 0 && skippedEntries.length > 0) {
                            Logger.logOutput(`[CacheManager] Summary: Cache initialization completed successfully, but ${skippedEntries.length} files were skipped during extraction:`);
                            skippedEntries.forEach(entry => {
                                Logger.logOutput(`  - Skipped: ${entry.file} (Reason: ${entry.reason})`);
                            });
                            this.context.workspaceState.update(stateKey, true);
                            resolve();
                        } else if (skippedEntries.length > 0) {
                            Logger.logOutput(`[CacheManager] Summary: Remote tar completed with ${skippedEntries.length} skipped entries:`);
                            skippedEntries.forEach(entry => {
                                Logger.logOutput(`  - Skipped: ${entry.file} (Reason: ${entry.reason})`);
                            });
                            
                            if (otherErrors.length > 0) {
                                Logger.logError(`[CacheManager] Unattributed tar errors:\n${otherErrors.join('\n')}`);
                            }
                            this.context.workspaceState.update(stateKey, true);
                            resolve();
                        } else {
                            Logger.logError(`[CacheManager] Remote tar failed with exit code ${remoteTarExitCode}. Unattributed errors:\n${otherErrors.join('\n')}`);
                            this.context.workspaceState.update(stateKey, false);
                            cleanupInFlight();
                            await fs.promises.rm(cacheDir, { recursive: true, force: true });
                            reject(new Error(`Remote tar failed with code ${remoteTarExitCode}`));
                        }
                    } catch (e) {
                        Logger.logError(`[CacheManager] Failed to retrieve remote tar status: ${e}`);
                        this.context.workspaceState.update(stateKey, false);
                        cleanupInFlight();
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
            if (localEntry === '.manifest.json') continue;
            if (!validSet.has(localEntry)) {
                const fullPath = path.join(localPath, localEntry);
                Logger.logOutput(`[CacheManager] Deleting local cache file not found on remote: ${fullPath}`);
                try {
                    await fs.promises.rm(fullPath, { recursive: true, force: true });
                    const rel = relPath ? path.posix.join(relPath, localEntry) : localEntry;
                    this.removeBaseline(deviceId, workspaceRoot, rel);
                } catch (e) {
                    Logger.logError(`[CacheManager] Failed to delete ${fullPath}: ${e}`);
                }
            }
        }
    }

    public async pullFileToCache(deviceId: string, workspaceRoot: string, relativePath: string): Promise<void> {
        const cacheDir = this.getCacheDir(deviceId, workspaceRoot);
        const adbPath = await this.connectionManager.toolsManager.getAdbPath();
        
        const safeWorkspaceRoot = escapePath(workspaceRoot);
        const safeRelPath = escapePath(relativePath);
        
        const shellCmd = `cd "${safeWorkspaceRoot}" && toybox tar chf - "${safeRelPath}" 2>/dev/null`;
        
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        let execOutCmd = shellCmd;
        if (shell.activeSwitchCommand) {
            const escapedCmd = shellCmd.replace(/'/g, "'\\''");
            if (shell.activeSwitchCommand.type === 'termux' || shell.activeSwitchCommand.type === 'custom') {
                execOutCmd = `run-as ${shell.activeSwitchCommand.pkgName} sh -c '${escapedCmd}'`;
            } else if (shell.activeSwitchCommand.type === 'root') {
                execOutCmd = `su -c '${escapedCmd}'`;
            }
        }

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading ${path.basename(relativePath)}...`,
            cancellable: true
        }, (progress, token) => {
            return new Promise<void>((resolve, reject) => {
                if (!fs.existsSync(cacheDir)) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                }
                
                Logger.logCommand(`"${adbPath}" -s ${deviceId} exec-out '${execOutCmd}'`);
                const adbProc = spawn(adbPath, ['-s', deviceId, 'exec-out', execOutCmd], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                const extractStream = tar.extract({ 
                    cwd: cacheDir,
                    onentry: (entry) => {
                        if (entry.type === 'File' && process.platform === 'win32') {
                            const check = isInvalidWindowsPath(entry.path);
                            if (check.invalid) {
                                Logger.logWarning(`[CacheManager] File is invalid on Windows "${entry.path}": ${check.reason}`);
                                vscode.window.showWarningMessage(`File is invalid on Windows (${check.reason}): ${entry.path}`);
                            }
                        }
                    }
                });
                
                const cleanupFile = () => {
                    const filePath = path.join(cacheDir, relativePath);
                    if (fs.existsSync(filePath)) {
                        try { fs.unlinkSync(filePath); } catch (e) {}
                    }
                };

                token.onCancellationRequested(() => {
                    adbProc.kill();
                    cleanupFile();
                    reject(new Error("Cancelled"));
                });
                
                adbProc.stdout.pipe(extractStream);
                
                extractStream.on('finish', async () => {
                    try {
                        const filePath = path.join(cacheDir, relativePath);
                        if (fs.existsSync(filePath)) {
                            const stat = await fs.promises.stat(filePath);
                            const content = await fs.promises.readFile(filePath);
                            const hash = crypto.createHash('md5').update(content).digest('hex');
                            this.updateBaseline(deviceId, workspaceRoot, relativePath, {
                                md5: hash,
                                mtime: Math.floor(stat.mtimeMs),
                                size: stat.size
                            });
                        }
                    } catch (e) {
                        Logger.logError(`[CacheManager] Failed to update baseline for ${relativePath}: ${e}`);
                    }
                    resolve();
                });
                extractStream.on('warn', (code, message, data) => {
                    const fileInfo = data?.path || data?.file || 'unknown';
                    Logger.logWarning(`[CacheManager] Tar extraction warning on ${fileInfo} (Code: ${code}): ${message}`);
                    vscode.window.showWarningMessage(`Could not save file to Windows cache: ${fileInfo}. (Likely contains illegal characters like ':')`);
                });
                
                extractStream.on('error', (err) => {
                    cleanupFile();
                    reject(err);
                });
                
                adbProc.on('close', (code) => {
                    if (code !== 0 && code !== null) {
                        Logger.logError(`[CacheManager] Single file pull adb exited with code ${code}`);
                    }
                });
            });
        });
    }
}
