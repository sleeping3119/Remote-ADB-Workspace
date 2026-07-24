import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as vscode from 'vscode';

import { PlatformToolsManager } from './platformToolsManager';
import { Logger } from '../logger';

export class ToyboxManager {
    private toolsManager: PlatformToolsManager;
    private context: vscode.ExtensionContext;
    private cachedPrefixes: Map<string, string> = new Map();
    private pendingPrefixes: Map<string, Promise<string>> = new Map();

    constructor(toolsManager: PlatformToolsManager, context: vscode.ExtensionContext) {
        this.toolsManager = toolsManager;
        this.context = context;
    }

    public async getToyboxPrefix(deviceId: string): Promise<string> {
        if (this.cachedPrefixes.has(deviceId)) {
            return this.cachedPrefixes.get(deviceId)!;
        }

        if (this.pendingPrefixes.has(deviceId)) {
            return this.pendingPrefixes.get(deviceId)!;
        }

        const promise = this._resolveToyboxPrefix(deviceId);
        this.pendingPrefixes.set(deviceId, promise);

        try {
            const prefix = await promise;
            this.cachedPrefixes.set(deviceId, prefix);
            return prefix;
        } finally {
            this.pendingPrefixes.delete(deviceId);
        }
    }

    private async _resolveToyboxPrefix(deviceId: string): Promise<string> {

        // 1. Check if natively available
        try {
            await this.execAdb(deviceId, 'shell toybox --version');
            this.cachedPrefixes.set(deviceId, 'toybox');
            return 'toybox';
        } catch (e) {
            // Natively not available, proceed to check /data/local/tmp/toybox
        }

        const tmpToyboxPath = '/data/local/tmp/toybox';
        try {
            await this.execAdb(deviceId, `shell ${tmpToyboxPath} --version`);
            this.cachedPrefixes.set(deviceId, tmpToyboxPath);
            return tmpToyboxPath;
        } catch (e) {
            // Not in tmp either
        }

        // 2. Need to download and push
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing Toybox for device ${deviceId}...`,
            cancellable: false
        }, async (progress) => {
            const abi = (await this.execAdb(deviceId, 'shell getprop ro.product.cpu.abi')).trim();
            const toyboxBinaryName = this.mapAbiToToybox(abi);
            
            const storagePath = this.context.globalStorageUri.fsPath;
            if (!fs.existsSync(storagePath)) {
                fs.mkdirSync(storagePath, { recursive: true });
            }
            const localToyboxPath = path.join(storagePath, `toybox-${toyboxBinaryName}`);

            if (!fs.existsSync(localToyboxPath)) {
                progress.report({ message: `Downloading toybox for ${abi}...` });
                const url = `https://landley.net/bin/toybox/latest/${toyboxBinaryName}`;
                await this.downloadFile(url, localToyboxPath);
            }

            progress.report({ message: `Pushing toybox to device...` });
            await this.execAdb(deviceId, `push "${localToyboxPath}" ${tmpToyboxPath}`);
            await this.execAdb(deviceId, `shell chmod +x ${tmpToyboxPath}`);

            this.cachedPrefixes.set(deviceId, tmpToyboxPath);
            return tmpToyboxPath;
        });
    }

    private mapAbiToToybox(abi: string): string {
        if (abi.startsWith('arm64')) {return 'toybox-aarch64';}
        if (abi.startsWith('armeabi')) {return 'toybox-armv7l';}
        if (abi === 'x86_64') {return 'toybox-x86_64';}
        if (abi === 'x86') {return 'toybox-i686';}
        return 'toybox-armv7l'; // fallback
    }

    private async execAdb(deviceId: string, args: string): Promise<string> {
        const adbPath = await this.toolsManager.getAdbPath();
        const cmd = `"${adbPath}" -s ${deviceId} ${args}`;
        Logger.logCommand(cmd);
        return new Promise((resolve, reject) => {
            cp.exec(cmd, (error, stdout, stderr) => {
                const combined = (stdout + '\n' + stderr).trim();
                if (error) {
                    Logger.logError(`[Toybox execAdb] Error: ${error.message}\nOutput: ${combined}`);
                    reject(new Error(combined || error.message));
                    return;
                }
                Logger.logOutput(combined);
                resolve(combined);
            });
        });
    }

    private downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
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
}
