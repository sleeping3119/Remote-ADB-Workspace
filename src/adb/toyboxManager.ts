import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import { PlatformToolsManager } from './platformToolsManager';
import { ConnectionManager } from './connectionManager';
import { Logger } from '../logger';

const RAW_DIR = '/data/local/tmp/.raw';
const TOYBOX_PATH = `${RAW_DIR}/toybox`;

export class ToyboxManager {
    private toolsManager: PlatformToolsManager;
    private context: vscode.ExtensionContext;
    private cachedPrefixes: Map<string, string> = new Map();
    private pendingPrefixes: Map<string, Promise<string>> = new Map();
    private rawFolderPaths: Map<string, string> = new Map();
    private connectionManager: ConnectionManager;

    constructor(toolsManager: PlatformToolsManager, context: vscode.ExtensionContext, connectionManager: ConnectionManager) {
        this.toolsManager = toolsManager;
        this.context = context;
        this.connectionManager = connectionManager;
    }

    public async getToyboxPrefix(deviceId: string, username: string = 'shell'): Promise<string> {
        const realId = await this.connectionManager.resolveDeviceId(deviceId);
        const key = `${realId}_${username}`;
        if (this.cachedPrefixes.has(key)) {
            return this.cachedPrefixes.get(key)!;
        }

        if (this.pendingPrefixes.has(key)) {
            return this.pendingPrefixes.get(key)!;
        }

        const promise = this._resolveToyboxPrefix(realId, username);
        this.pendingPrefixes.set(key, promise);

        try {
            const prefix = await promise;
            this.cachedPrefixes.set(key, prefix);
            return prefix;
        } finally {
            this.pendingPrefixes.delete(key);
        }
    }

    public setToyboxPrefix(deviceId: string, username: string, prefix: string): void {
        const realId = this.connectionManager.getRealDeviceIdSync(deviceId);
        const key = `${realId}_${username}`;
        this.cachedPrefixes.set(key, prefix);
    }

    public async getRawFolderPath(deviceId: string, username: string = 'shell', shell?: import('./connectionManager').PersistentAdbShell): Promise<string> {
        const realId = await this.connectionManager.resolveDeviceId(deviceId);
        const key = `${realId}_${username}`;
        const folderPath = this.rawFolderPaths.get(key) || RAW_DIR;
        
        if (folderPath === RAW_DIR) {
            try {
                await this.execAdb(realId, `shell mkdir -p ${RAW_DIR}`);
                // Use 777 to allow apps like termux to read/write files pushed here by adb host
                await this.execAdb(realId, `shell chmod 777 ${RAW_DIR}`);
            } catch (e) {}
        } else if (shell) {
            try {
                await shell.executeCommand(`mkdir -p ${folderPath}`);
                await shell.executeCommand(`chmod 700 ${folderPath}`);
            } catch (e) {}
        }
        
        return folderPath;
    }

    public setRawFolderPath(deviceId: string, username: string, path: string): void {
        const realId = this.connectionManager.getRealDeviceIdSync(deviceId);
        const key = `${realId}_${username}`;
        this.rawFolderPaths.set(key, path);
    }

    private async _resolveToyboxPrefix(deviceId: string, username: string): Promise<string> {
        if (username === 'shell' || username === 'root') {
            this.setRawFolderPath(deviceId, username, RAW_DIR);
            await this.getRawFolderPath(deviceId, username);
        }

        // 1. Check if already pushed
        try {
            await this.execAdb(deviceId, `shell ${TOYBOX_PATH} --version`);
            this.setToyboxPrefix(deviceId, username, TOYBOX_PATH);
            return TOYBOX_PATH;
        } catch (e) {
            // Not in .raw, need to push bundled version
        }

        // 2. Need to push bundled binary
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing Toybox for device ${deviceId}...`,
            cancellable: false
        }, async (progress) => {
            const abi = (await this.execAdb(deviceId, 'shell getprop ro.product.cpu.abi')).trim();
            const toyboxBinaryName = this.mapAbiToToybox(abi);
            
            const localToyboxPath = path.join(this.context.extensionUri.fsPath, 'resources', 'toybox', toyboxBinaryName);

            if (!fs.existsSync(localToyboxPath)) {
                vscode.window.showErrorMessage(`Bundled toybox binary not found at ${localToyboxPath}`);
                throw new Error(`Bundled toybox not found for ABI ${abi}`);
            }

            progress.report({ message: `Pushing toybox to device...` });
            await this.getRawFolderPath(deviceId, username);
            await this.execAdb(deviceId, `push "${localToyboxPath}" ${TOYBOX_PATH}`);
            await this.execAdb(deviceId, `shell chmod 755 ${TOYBOX_PATH}`);

            this.setToyboxPrefix(deviceId, username, TOYBOX_PATH);
            return TOYBOX_PATH;
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
        const realId = await this.connectionManager.resolveDeviceId(deviceId);
        const cmd = `"${adbPath}" -s ${realId} ${args}`;
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


}
