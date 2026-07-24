import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';
import AdmZip from 'adm-zip';

export class PlatformToolsManager {
    private readonly MIN_ADB_VERSION = '34.0.0'; // Define our supported minimum version
    private context: vscode.ExtensionContext;
    private adbPath: string | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public async getAdbPath(): Promise<string> {
        if (this.adbPath) {
            return this.adbPath;
        }

        // 1. Check User Settings
        const configPath = vscode.workspace.getConfiguration('remote-adb').get<string>('adbPath');
        if (configPath && fs.existsSync(configPath)) {
            this.adbPath = configPath;
            return this.adbPath;
        }

        // 2. Check system PATH and version
        const systemAdbPath = 'adb';
        try {
            const versionOutput = await this.executeCommand(`${systemAdbPath} version`);
            if (this.isVersionSupported(versionOutput)) {
                this.adbPath = systemAdbPath;
                return this.adbPath;
            }
        } catch (e) {
            // adb not found in path or failed to execute
        }

        // 3. Check if already downloaded in global storage
        const storagePath = this.context.globalStorageUri.fsPath;
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }
        const platform = os.platform();
        const ext = platform === 'win32' ? '.exe' : '';
        const downloadedAdbPath = path.join(storagePath, 'platform-tools', `adb${ext}`);

        if (fs.existsSync(downloadedAdbPath)) {
            try {
                const versionOutput = await this.executeCommand(`"${downloadedAdbPath}" version`);
                if (this.isVersionSupported(versionOutput)) {
                    this.adbPath = downloadedAdbPath;
                    return this.adbPath;
                }
            } catch (e) {
                // Ignore, will re-download
            }
        }

        // 4. Download latest platform tools
        await this.downloadPlatformTools(storagePath);
        this.adbPath = downloadedAdbPath;
        
        // Ensure executable permissions on mac/linux
        if (platform !== 'win32' && fs.existsSync(this.adbPath)) {
            fs.chmodSync(this.adbPath, 0o755);
        }

        return this.adbPath;
    }

    private isVersionSupported(versionOutput: string): boolean {
        // Output looks like: "Android Debug Bridge version 1.0.41\nVersion 34.0.4-10411341\n..."
        const match = versionOutput.match(/Version\s+(\d+\.\d+\.\d+)/);
        if (match && match[1]) {
            const installedVersion = match[1];
            return this.compareVersions(installedVersion, this.MIN_ADB_VERSION) >= 0;
        }
        return false;
    }

    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const num1 = parts1[i] || 0;
            const num2 = parts2[i] || 0;
            if (num1 > num2) {return 1;}
            if (num1 < num2) {return -1;}
        }
        return 0;
    }

    private async downloadPlatformTools(destPath: string): Promise<void> {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Remote ADB",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Downloading latest platform-tools..." });

            const platform = os.platform();
            let platformKey = 'windows';
            if (platform === 'darwin') {platformKey = 'darwin';}
            else if (platform === 'linux') {platformKey = 'linux';}

            const url = `https://dl.google.com/android/repository/platform-tools-latest-${platformKey}.zip`;
            const zipPath = path.join(destPath, 'platform-tools.zip');

            await this.downloadFile(url, zipPath);

            progress.report({ message: "Extracting platform-tools..." });
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(destPath, true);

            fs.unlinkSync(zipPath); // Cleanup zip
            
            vscode.window.showInformationMessage("Remote ADB: Successfully downloaded and installed the latest Android platform-tools.");
        });
    }

    private downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    // Handle redirect
                    if (response.headers.location) {
                        this.downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                        return;
                    }
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download: ${response.statusCode}`));
                    return;
                }

                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlinkSync(dest);
                reject(err);
            });
        });
    }

    private executeCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.exec(command, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }
}
