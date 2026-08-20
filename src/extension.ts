import * as vscode from 'vscode';
import { PlatformToolsManager } from './adb/platformToolsManager';
import { ConnectionManager } from './adb/connectionManager';
import { ToyboxManager } from './adb/toyboxManager';
import { CacheManager } from './fs/cacheManager';
import { AdbFileSystemProvider } from './fs/adbFileSystemProvider';
import { Logger } from './logger';
import { DeviceTreeProvider, DeviceTreeItem } from './tree/deviceTreeProvider';
import { showFolderPicker, triggerAcceptFolderPicker } from './ui/folderPicker';
import { showFilePicker, triggerAcceptFilePicker } from './ui/filePicker';
import { ValidationManager } from './adb/validationManager';

export async function activate(context: vscode.ExtensionContext) {
    /** Strip characters that are illegal in Windows filenames: / \ : * ? " < > | */
    const sanitizeKey = (s: string) => s.replace(/\/+$/, '').replace(/[/\\:*?"<>|]/g, '_');
    Logger.initialize(context);
    console.log('Congratulations, your extension "remote-adb" is now active!');
    
    let reopenWorkspaceTerminal: ((reconnectedDeviceId: string) => Promise<void>) | undefined;

    const toolsManager = new PlatformToolsManager(context);
    const connectionManager = new ConnectionManager(context, toolsManager);
    const toyboxManager = new ToyboxManager(toolsManager, context, connectionManager);
    const cacheManager = new CacheManager(context, connectionManager, toyboxManager);

    const fsProvider = new AdbFileSystemProvider(connectionManager, toyboxManager, cacheManager);
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('remote-adb', fsProvider, { isCaseSensitive: true }));

    const validationManager = new ValidationManager(connectionManager, toyboxManager);

    const deviceTreeProvider = new DeviceTreeProvider(connectionManager);
    vscode.window.registerTreeDataProvider('remote-adb.devicesView', deviceTreeProvider);

    let refreshDevicesDisposable = vscode.commands.registerCommand('remote-adb.refreshDevices', () => {
        deviceTreeProvider.refresh();
    });
    context.subscriptions.push(refreshDevicesDisposable);

    // Status Bar Item for device
    const deviceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    deviceStatusBar.command = 'remote-adb.switchDevice';
    context.subscriptions.push(deviceStatusBar);

    function updateStatusBar() {
        const active = connectionManager.getActiveDevice();
        if (active) {
            deviceStatusBar.text = `$(device-mobile) ADB: ${active}`;
            deviceStatusBar.show();
        } else {
            deviceStatusBar.hide();
        }
    }

    // Run auto-connect in the background immediately
    const autoConnectPromise = (async () => {
        const savedConnections = vscode.workspace.getConfiguration().get<any[]>('remote-adb.savedConnections') || [];
        if (savedConnections.length === 0) return;

        try {
            await connectionManager.startServer();
        } catch (e: any) {
            Logger.logWarning(`[Auto-Connect] Failed to start ADB server: ${e.message}`);
            return;
        }

        for (const conn of savedConnections) {
            let ipPort = conn.ipPort?.trim();
            if (!ipPort) { continue; }
            if (!ipPort.includes(':')) { ipPort += ':5555'; }

            try {
                Logger.logOutput(`[Auto-Connect] Connecting to saved connection: ${conn.alias || ipPort}`);
                const result = await connectionManager.connect(ipPort);
                Logger.logOutput(`[Auto-Connect] ${result}`);

                if (result.includes('failed to connect to') || result.includes('actively refused it') || result.includes('cannot connect to')) {
                    Logger.logWarning(`[Auto-Connect] Could not reach ${ipPort}: ${result}`);
                    continue;
                }

                const isReady = await connectionManager.waitForDeviceReady(ipPort, 10000);
                if (!isReady) {
                    Logger.logWarning(`[Auto-Connect] ${ipPort} connected but device is not ready`);
                    continue;
                }

                connectionManager.setActiveDevice(ipPort);

                // Switch user if specified
                if (conn.user && conn.user !== 'shell') {
                    try {
                        const success = await switchDeviceUser(ipPort, conn.user, conn.customApp);
                        if (success) {
                            Logger.logOutput(`[Auto-Connect] Switched to ${conn.user} on ${ipPort}`);
                        } else {
                            Logger.logWarning(`[Auto-Connect] Failed to switch user to ${conn.user} on ${ipPort}`);
                        }
                    } catch (e: any) {
                        Logger.logWarning(`[Auto-Connect] User switch error on ${ipPort}: ${e.message}`);
                    }
                }

                Logger.logOutput(`[Auto-Connect] ${conn.alias || ipPort} is ready`);
            } catch (e: any) {
                Logger.logWarning(`[Auto-Connect] Failed to connect to ${ipPort}: ${e.message}`);
            }
        }

        deviceTreeProvider.refresh();
        updateStatusBar();
    })();

    async function processAdbFolderManifest(
        targetDeviceId: string,
        targetFolderPath: string,
        manifestsMap: Record<string, any>
    ): Promise<any> {
        const key = `${targetDeviceId}:${targetFolderPath}`;
        const tempKey = `adbValidationManifest_${sanitizeKey(targetDeviceId)}_${sanitizeKey(targetFolderPath)}.json`;
        const manifestUri = vscode.Uri.joinPath(context.globalStorageUri, tempKey);

        let slimManifest: any = undefined;
        try {
            const fs = require('fs');
            if (fs.existsSync(manifestUri.fsPath)) {
                const data = await fs.promises.readFile(manifestUri.fsPath);
                const fullManifest = JSON.parse(data.toString());
                Logger.logOutput(`[Extension Activate] Found global manifest file for ${targetFolderPath}. Processing slim manifest for workspace state.`);
                Logger.logOutput(`[ADB Workspace Validation Manifest]\n${JSON.stringify(fullManifest, null, 2)}`);

                slimManifest = {
                    workspaceRoot: fullManifest.workspaceRoot,
                    user: fullManifest.privilegeContext?.user || 'shell',
                    switchCommand: fullManifest.privilegeContext?.switchCommand
                };
                manifestsMap[key] = slimManifest;
                await fs.promises.unlink(manifestUri.fsPath).catch(() => {});
            }
        } catch (e) {
            Logger.logError(`[Extension Activate] Error reading manifest for ${targetFolderPath}: ${e}`);
        }

        if (!slimManifest && manifestsMap[key]) {
            slimManifest = manifestsMap[key];
        }

        if (!slimManifest) {
            const legacy = context.workspaceState.get<any>('adbValidationManifest');
            if (legacy && (legacy.workspaceRoot === targetFolderPath || legacy.workspaceRoot?.replace(/\/+$/, '') === targetFolderPath.replace(/\/+$/, ''))) {
                slimManifest = legacy;
                manifestsMap[key] = slimManifest;
            }
        }

        if (slimManifest && context.storageUri) {
            try {
                await vscode.workspace.fs.createDirectory(context.storageUri);
                const perFolderManifestUri = vscode.Uri.joinPath(context.storageUri, `manifest_${sanitizeKey(targetDeviceId)}_${sanitizeKey(targetFolderPath)}.json`);
                await vscode.workspace.fs.writeFile(perFolderManifestUri, new TextEncoder().encode(JSON.stringify(slimManifest, null, 2)));
                Logger.logOutput(`[Extension Activate] Saved per-folder manifest to workspace storage: ${perFolderManifestUri.fsPath}`);
            } catch (e) {
                Logger.logError(`[Extension Activate] Failed to write per-folder manifest: ${e}`);
            }
        }

        return slimManifest;
    }

    // If we are opening a remote-adb workspace, retrieve the manifests and initialize cache
    const adbFolders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'remote-adb');
    if (adbFolders && adbFolders.length > 0) {
        // Create an initialization lock IMMEDIATELY to block early FS operations
        let resolveInit!: () => void;
        const initPromise = new Promise<void>(r => resolveInit = r);
        connectionManager.setShellInitializing(initPromise);

        try {
            const primaryFolder = adbFolders[0];
            const primaryDeviceId = primaryFolder.uri.authority;
            const manifestsMap: Record<string, any> = context.workspaceState.get('adbValidationManifests') || {};
            let primarySlimManifest: any = undefined;

            for (const folder of adbFolders) {
                const deviceId = folder.uri.authority;
                const folderPath = folder.uri.path;
                const slimManifest = await processAdbFolderManifest(deviceId, folderPath, manifestsMap);
                if (folder === primaryFolder) {
                    primarySlimManifest = slimManifest;
                }
            }

            await context.workspaceState.update('adbValidationManifests', manifestsMap);

            if (primarySlimManifest) {
                await context.workspaceState.update('adbValidationManifest', primarySlimManifest);
                if (context.storageUri) {
                    const localManifestUri = vscode.Uri.joinPath(context.storageUri, 'manifest.json');
                    await vscode.workspace.fs.writeFile(localManifestUri, new TextEncoder().encode(JSON.stringify(primarySlimManifest, null, 2)));
                    Logger.logOutput(`[Extension Activate] Saved primary slim manifest to workspace storage: ${localManifestUri.fsPath}`);
                }

                // Try to resolve the androidId. If it's not found, wait for autoConnectPromise to see if it connects.
                let adbId = await connectionManager.resolveDeviceId(primaryDeviceId);
                if (adbId === primaryDeviceId) {
                    Logger.logOutput(`[Extension Activate] Device with Android ID ${primaryDeviceId} not found, waiting for auto-connects to finish...`);
                    await autoConnectPromise;
                    adbId = await connectionManager.resolveDeviceId(primaryDeviceId);
                    if (adbId === primaryDeviceId) {
                        vscode.window.showErrorMessage(`ADB Workspace failed to load: Device with Android ID ${primaryDeviceId} is not connected.`);
                    }
                }

                try {
                    // Auto-restore environment if required
                    const switchCmd = primarySlimManifest.switchCommand;
                    if (switchCmd && switchCmd.type !== 'shell') {
                        const shell = await connectionManager.getPersistentShell(primaryDeviceId);
                        const currentUser = await shell.getCurrentUser();
                        
                        if (currentUser.name === 'shell') {
                            Logger.logOutput(`[Extension Activate] Restoring active user environment: ${switchCmd.type}`);
                            if (switchCmd.type === 'root') {
                                await shell.sendRawCommand('su');
                                shell.refreshCurrentUser();
                                shell.activeSwitchCommand = { type: 'root' };
                            } else if (switchCmd.type === 'termux') {
                                await setupAppEnvironment(adbId, 'com.termux', shell, './files/home/.raw');
                            } else if (switchCmd.type === 'custom' && switchCmd.pkgName) {
                                await setupAppEnvironment(adbId, switchCmd.pkgName, shell);
                            }
                        }
                    }
                } catch (err: any) {
                    Logger.logError(`[Extension Activate] Failed to restore environment: ${err.message}`);
                }

                const createProfile = async () => {
                    const adbPath = await toolsManager.getAdbPath();
                    const root = primarySlimManifest.workspaceRoot;
                    const realId = await connectionManager.resolveDeviceId(primaryDeviceId);
                    let shellArgs = ['-s', realId, 'shell', '-t'];
                    const switchCmd = primarySlimManifest.switchCommand;
                    
                    if (switchCmd && switchCmd.type !== 'shell') {
                        if (switchCmd.type === 'termux') {
                            shellArgs.push('run-as', 'com.termux', 'sh', '-c', `\"cd '${root}' && exec sh\"`);
                        } else if (switchCmd.type === 'custom') {
                            shellArgs.push('run-as', switchCmd.pkgName!, 'sh', '-c', `\"cd '${root}' && exec sh\"`);
                        } else if (switchCmd.type === 'root') {
                            shellArgs.push('su');
                        }
                    } else {
                        shellArgs.push('sh', '-c', `\"cd '${root}' && exec sh\"`);
                    }

                    return new vscode.TerminalProfile({
                        name: 'ADB Shell',
                        shellPath: adbPath,
                        shellArgs: shellArgs,
                        iconPath: new vscode.ThemeIcon('terminal-linux')
                    });
                };

                reopenWorkspaceTerminal = async (reconnectedDeviceId: string) => {
                    const realId = await connectionManager.resolveDeviceId(primaryDeviceId);
                    const reconnectedRealId = await connectionManager.resolveDeviceId(reconnectedDeviceId);
                    if (reconnectedRealId === realId) {
                        const existing = vscode.window.terminals.find(t => t.name === 'ADB Shell' && t.exitStatus === undefined);
                        if (!existing) {
                            try {
                                const profile = await createProfile();
                                const terminal = vscode.window.createTerminal(profile.options as vscode.TerminalOptions);
                                terminal.show();
                            } catch (e) {
                                Logger.logError(`Failed to reopen terminal: ${e}`);
                            }
                        }
                    }
                };

                context.subscriptions.push(vscode.window.registerTerminalProfileProvider('remote-adb.terminalProfile', {
                    provideTerminalProfile(token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
                        return createProfile();
                    }
                }));

                // Automatically open the terminal when workspace starts
                createProfile().then(profile => {
                    const terminal = vscode.window.createTerminal(profile.options as vscode.TerminalOptions);
                    terminal.show();
                }).catch(e => {
                    Logger.logError(`[Extension Activate] Failed to auto-start terminal: ${e}`);
                });

                // Listen for newly opened ADB Shell terminals to inject root commands
                context.subscriptions.push(vscode.window.onDidOpenTerminal(terminal => {
                    if (terminal.name === 'ADB Shell' && primarySlimManifest.switchCommand?.type === 'root') {
                        // Send the directory change command directly to the interactive root shell
                        terminal.sendText(`cd '${primarySlimManifest.workspaceRoot}' && clear`);
                    }
                }));
            } else {
                Logger.logOutput(`[Extension Activate] No manifest available.`);
            }
            
            // Ensure the Explorer view is brought to focus
            vscode.commands.executeCommand('workbench.view.explorer');
        } finally {
            resolveInit();
        }

        // Trigger cache initialization for every folder AFTER environment is restored and shell is ready
        for (const folder of adbFolders) {
            const deviceId = folder.uri.authority;
            const folderPath = folder.uri.path;
            cacheManager.initializeCache(deviceId, folderPath).catch(e => {
                Logger.logError(`[Extension Activate] Cache initialization failed for ${folderPath}: ${e}`);
            });
        }
    }

    // Dynamic workspace folders listener
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        const manifestsMap: Record<string, any> = context.workspaceState.get('adbValidationManifests') || {};
        for (const folder of e.added) {
            if (folder.uri.scheme === 'remote-adb') {
                const deviceId = folder.uri.authority;
                const folderPath = folder.uri.path;
                Logger.logOutput(`[Workspace Folder Added] Initializing cache for added folder: ${folderPath}`);
                await processAdbFolderManifest(deviceId, folderPath, manifestsMap);
                await context.workspaceState.update('adbValidationManifests', manifestsMap);
                cacheManager.initializeCache(deviceId, folderPath).catch(err => {
                    Logger.logError(`[Workspace Folder Added] Cache initialization failed for ${folderPath}: ${err}`);
                });
            }
        }
    }));
    // Command: Switch Device
    let switchDeviceDisposable = vscode.commands.registerCommand('remote-adb.switchDevice', async () => {
        const devices = await connectionManager.getDevices();
        if (devices.length === 0) {
            vscode.window.showInformationMessage('No ADB devices found.');
            return;
        }

        const items = devices.map(d => ({
            label: d.id,
            description: d.status
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select active ADB device'
        });

        if (selected) {
            connectionManager.setActiveDevice(selected.label);
            updateStatusBar();
            vscode.window.showInformationMessage(`Switched to device: ${selected.label}`);
        }
    });

    connectionManager.onDeviceDisconnected(async (deviceId) => {
        vscode.commands.executeCommand('remote-adb.refreshDevices');
        const selection = await vscode.window.showErrorMessage(
            `ADB connection to ${deviceId} closed unexpectedly. The device might have been disconnected.`,
            'Reconnect',
            'Dismiss'
        );
        if (selection === 'Reconnect') {
            vscode.commands.executeCommand('remote-adb.handleOfflineDevice', { device: { id: deviceId } });
        }
    });

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.acceptFolderPicker', () => {
        if (triggerAcceptFolderPicker) {
            triggerAcceptFolderPicker();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.acceptFilePicker', () => {
        if (triggerAcceptFilePicker) {
            triggerAcceptFilePicker();
        }
    }));

    // Command: Open Folder
    let openFolderDisposable = vscode.commands.registerCommand('remote-adb.openFolder', async (deviceItem?: DeviceTreeItem) => {
        try {
            let active = deviceItem ? deviceItem.device.id : connectionManager.getActiveDevice();
            if (!active) {
                const devices = await connectionManager.getDevices();
                const connected = devices.filter(d => d.status === 'device');
                if (connected.length > 0) {
                    active = connected[0].id;
                    connectionManager.setActiveDevice(active);
                    updateStatusBar();
                } else {
                    vscode.window.showErrorMessage('No connected device. Connect a device first.');
                    return;
                }
            }
        
            const shell = await connectionManager.getPersistentShell(active);
            const pwd = await shell.executeCommand('pwd');
            let initialPath = pwd.trim() || '/';
            const user = await shell.getCurrentUser();
            if (shell.activeSwitchCommand?.type === 'termux') {
                initialPath = '/data/user/0/com.termux/files/home/';
            } else if (user.name === 'shell' && initialPath === '/') {
                initialPath = '/data/local/tmp';
            }
            const folderPath = await showFolderPicker(active, fsProvider, initialPath);
            if (folderPath) {
                const androidId = await connectionManager.resolveAndroidIdForDevice(active) || active;
                const existingAdbFolders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'remote-adb') || [];

                // Check device mismatch if adding to existing workspace
                if (existingAdbFolders.length > 0) {
                    const existingAndroidId = existingAdbFolders[0].uri.authority;
                    if (existingAndroidId !== androidId) {
                        const choice = await vscode.window.showWarningMessage(
                            `Device Mismatch: The current workspace is connected to device (${existingAndroidId}), but the selected folder belongs to device (${active}). A single workspace can only contain folders from the same device.`,
                            { modal: true },
                            'Open in New Window'
                        );
                        if (choice === 'Open in New Window') {
                            const manifest = await validationManager.validateWorkspace(active, folderPath);
                            if (!manifest) return;
                            const tempKey = `adbValidationManifest_${sanitizeKey(androidId)}_${sanitizeKey(folderPath)}.json`;
                            const manifestUri = vscode.Uri.joinPath(context.globalStorageUri, tempKey);
                            await vscode.workspace.fs.createDirectory(context.globalStorageUri);
                            await vscode.workspace.fs.writeFile(manifestUri, new TextEncoder().encode(JSON.stringify(manifest)));
                            await new Promise(resolve => setTimeout(resolve, 500));
                            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`remote-adb://${androidId}${folderPath}`), { forceNewWindow: true });
                        }
                        return;
                    }
                }

                // Stage 1-6: Target Path Validation Phase
                const manifest = await validationManager.validateWorkspace(active, folderPath);
                if (!manifest) {
                    // User aborted or validation failed terminally
                    return;
                }

                // Check user/privilege environment compatibility if adding to existing workspace
                if (existingAdbFolders.length > 0) {
                    const manifestsMap: Record<string, any> = context.workspaceState.get('adbValidationManifests') || {};
                    const primaryKey = `${existingAdbFolders[0].uri.authority}:${existingAdbFolders[0].uri.path}`;
                    const primaryManifest = manifestsMap[primaryKey] || context.workspaceState.get<any>('adbValidationManifest');
                    const workspaceSwitchCmd = primaryManifest?.switchCommand || { type: 'shell' };
                    const workspaceUser = primaryManifest?.user || 'shell';

                    const targetSwitchCmd = manifest.privilegeContext?.switchCommand || { type: 'shell' };

                    const isSameEnv = (targetSwitchCmd.type === workspaceSwitchCmd.type) && 
                                      (targetSwitchCmd.type !== 'custom' || targetSwitchCmd.pkgName === (workspaceSwitchCmd as any).pkgName);

                    if (!isSameEnv) {
                        const workspaceEnvLabel = workspaceSwitchCmd.type === 'custom' ? (workspaceSwitchCmd as any).pkgName : workspaceSwitchCmd.type;
                        const targetEnvLabel = targetSwitchCmd.type === 'custom' ? targetSwitchCmd.pkgName : targetSwitchCmd.type;
                        const targetUserLabel = manifest.privilegeContext?.user || 'shell';

                        const choice = await vscode.window.showWarningMessage(
                            `User Environment Mismatch: The current workspace is configured for user '${workspaceUser}' (${workspaceEnvLabel}), but the selected folder requires '${targetUserLabel}' (${targetEnvLabel}). A single workspace cannot mix different active user environments. Please close the current workspace first or open this folder in a new window.`,
                            { modal: true },
                            'Open in New Window'
                        );
                        if (choice === 'Open in New Window') {
                            const tempKey = `adbValidationManifest_${sanitizeKey(androidId)}_${sanitizeKey(folderPath)}.json`;
                            const manifestUri = vscode.Uri.joinPath(context.globalStorageUri, tempKey);
                            await vscode.workspace.fs.createDirectory(context.globalStorageUri);
                            await vscode.workspace.fs.writeFile(manifestUri, new TextEncoder().encode(JSON.stringify(manifest)));
                            await new Promise(resolve => setTimeout(resolve, 500));
                            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`remote-adb://${androidId}${folderPath}`), { forceNewWindow: true });
                        }
                        return;
                    }
                }
                
                // Persist the manifest to global storage for workspace reload scenarios
                const tempKey = `adbValidationManifest_${sanitizeKey(androidId)}_${sanitizeKey(folderPath)}.json`;
                const manifestUri = vscode.Uri.joinPath(context.globalStorageUri, tempKey);
                
                try {
                    // Ensure the global storage directory exists
                    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
                    // Write the manifest to disk
                    const data = new TextEncoder().encode(JSON.stringify(manifest));
                    await vscode.workspace.fs.writeFile(manifestUri, data);
                    Logger.logOutput(`[Validation] Saved manifest to disk: ${manifestUri.fsPath}`);
                } catch (e: any) {
                    Logger.logError(`[Validation] Failed to save manifest to disk: ${e.message}`);
                }
                
                // Log immediately in case the window doesn't reload
                Logger.logOutput(`[ADB Workspace Validation Manifest]\n${JSON.stringify(manifest, null, 2)}`);

                // Give the extension host file system a moment to physically flush the JSON file 
                // before the restart caused by updateWorkspaceFolders.
                await new Promise(resolve => setTimeout(resolve, 500));

                vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
                    0,
                    { uri: vscode.Uri.parse(`remote-adb://${androidId}${folderPath}`), name: `ADB: ${active}${folderPath}` }
                );
            }
        } catch (error: any) {
            if (error.message && (error.message.includes('ADB shell closed') || error.message.includes('ADB shell is dead'))) {
                vscode.window.showErrorMessage(`Action failed: You are no longer connected to the device.`);
            } else {
                vscode.window.showErrorMessage(`Failed to open folder: ${error.message}`);
            }
        }
    });

    // Command: Open File
    let openFileDisposable = vscode.commands.registerCommand('remote-adb.openFile', async (deviceItem?: DeviceTreeItem) => {
        try {
            let active = deviceItem ? deviceItem.device.id : connectionManager.getActiveDevice();
            if (!active) {
                const devices = await connectionManager.getDevices();
                const connected = devices.filter(d => d.status === 'device');
                if (connected.length > 0) {
                    active = connected[0].id;
                    connectionManager.setActiveDevice(active);
                    updateStatusBar();
                } else {
                    vscode.window.showErrorMessage('No connected device. Connect a device first.');
                    return;
                }
            }
        
        const shell = await connectionManager.getPersistentShell(active);
        const pwd = await shell.executeCommand('pwd');
        let initialPath = pwd.trim() || '/';
        const user = await shell.getCurrentUser();
        if (shell.activeSwitchCommand?.type === 'termux') {
            initialPath = '/data/user/0/com.termux/files/home/';
        } else if (user.name === 'shell' && initialPath === '/') {
            initialPath = '/data/local/tmp';
        }
        const filePath = await showFilePicker(active, fsProvider, initialPath);
        if (filePath) {
            const isValid = await validationManager.validateFile(active, filePath);
            if (!isValid) {
                return;
            }
            
            const androidId = await connectionManager.resolveAndroidIdForDevice(active) || active;
            const uri = vscode.Uri.parse(`remote-adb://${androidId}${filePath}`);
            vscode.commands.executeCommand('vscode.open', uri);
        }
        } catch (error: any) {
            if (error.message && (error.message.includes('ADB shell closed') || error.message.includes('ADB shell is dead'))) {
                vscode.window.showErrorMessage(`Action failed: You are no longer connected to the device.`);
            } else {
                vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
            }
        }
    });

    context.subscriptions.push(openFolderDisposable, openFileDisposable);

    let rebuildCacheDisposable = vscode.commands.registerCommand('remote-adb.rebuildCache', async () => {
        const adbFolders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'remote-adb');
        if (!adbFolders || adbFolders.length === 0) {
            vscode.window.showInformationMessage('No Remote ADB workspace folder is currently open.');
            return;
        }

        for (const folder of adbFolders) {
            const deviceId = folder.uri.authority;
            const folderPath = folder.uri.path;
            try {
                await cacheManager.initializeCache(deviceId, folderPath, true);
                vscode.window.showInformationMessage(`Workspace cache rebuilt successfully for ${folderPath}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to rebuild cache for ${folderPath}: ${e.message}`);
            }
        }
    });

    context.subscriptions.push(rebuildCacheDisposable);

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.handleUnauthorizedDevice', async (item: DeviceTreeItem) => {
        if (!item || !item.device) return;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Resolving unauthorized device..." }, async () => {
            await connectionManager.killServer();
            if (item.device.id.includes(':')) {
                try { await connectionManager.connect(item.device.id); } catch(e) {}
            }
            vscode.window.showWarningMessage(`Please check your device (${item.device.id}) and allow the USB debugging prompt.`);
            vscode.commands.executeCommand('remote-adb.refreshDevices');
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.handleOfflineDevice', async (item: DeviceTreeItem) => {
        if (!item || !item.device) return;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Resolving offline device..." }, async () => {
            await connectionManager.killServer();
            if (item.device.id.includes(':')) {
                try { await connectionManager.connect(item.device.id); } catch(e) {}
            }
            
            // Wait for device to become 'device' status
            const isReady = await connectionManager.waitForDeviceReady(item.device.id, 10000);
            if (!isReady) {
                vscode.window.showErrorMessage(`Device ${item.device.id} is not responding or disconnected. Please reconnect the device or restart ADB on the phone.`);
            } else {
                vscode.window.showInformationMessage(`Device ${item.device.id} reconnected successfully.`);
                if (reopenWorkspaceTerminal) {
                    await reopenWorkspaceTerminal(item.device.id);
                }
            }
            vscode.commands.executeCommand('remote-adb.refreshDevices');
        });
    }));

    async function setupAppEnvironment(deviceId: string, pkgName: string, shell: import('./adb/connectionManager').PersistentAdbShell, targetFolder: string = '.raw') {
        return new Promise<boolean>(async (resolve) => {
            const cp = require('child_process');
            const adbPath = await toolsManager.getAdbPath();
            cp.exec(`"${adbPath}" -s ${deviceId} shell run-as ${pkgName} id`, async (err: any, stdout: string, stderr: string) => {
                const out = (stdout + '' + stderr).toLowerCase();
                if (out.includes('unknown package') || out.includes('is not installed')) {
                    vscode.window.showErrorMessage(`Package not installed: ${pkgName}`);
                    return resolve(false);
                }
                if (out.includes('not debuggable') || out.includes('not an application') || err) {
                    vscode.window.showErrorMessage(`Package not debuggable or run-as failed: ${pkgName}`);
                    return resolve(false);
                }
                
                let user = await shell.getCurrentUser();
                if (user.name !== 'shell') {
                    await shell.sendRawCommand('exit');
                    shell.refreshCurrentUser();
                }
                
                await shell.sendRawCommand(`run-as ${pkgName}`);
                shell.refreshCurrentUser();
                user = await shell.getCurrentUser();
                
                // Get absolute path
                let absTargetFolder = targetFolder;
                if (!absTargetFolder.startsWith('/')) {
                    const pwdOut = await shell.executeCommand('pwd');
                    const pwd = pwdOut.trim();
                    absTargetFolder = absTargetFolder.replace(/^\.\//, '');
                    absTargetFolder = `${pwd}/${absTargetFolder}`;
                }

                // Always ensure the target folder parent exists
                if (absTargetFolder.includes('/')) {
                    const parent = absTargetFolder.substring(0, absTargetFolder.lastIndexOf('/'));
                    await shell.executeCommand(`mkdir -p ${parent}`);
                }
                
                // Register path and let getRawFolderPath handle directory creation and permissions
                toyboxManager.setRawFolderPath(deviceId, user.name, absTargetFolder);
                await toyboxManager.getRawFolderPath(deviceId, user.name, shell);

                // Force ToyboxManager to ensure the global shell toybox is pushed and available.
                await toyboxManager.getToyboxPrefix(deviceId, 'shell');

                const testLocal = await shell.executeCommand(`${absTargetFolder}/toybox --version`);
                if (testLocal.includes('not found') || testLocal.includes('inaccessible') || testLocal.includes('No such file') || testLocal.includes('Permission denied')) {
                    await shell.executeCommand(`cat /data/local/tmp/.raw/toybox > ${absTargetFolder}/toybox`);
                    await shell.executeCommand(`chmod 700 ${absTargetFolder}/toybox`);
                }
                toyboxManager.setToyboxPrefix(deviceId, user.name, `${absTargetFolder}/toybox`);
                shell.activeSwitchCommand = { type: pkgName === 'com.termux' ? 'termux' : 'custom', pkgName };
                vscode.window.showInformationMessage(`Switched to ${pkgName}`);
                vscode.commands.executeCommand('remote-adb.refreshDevices');
                resolve(true);
            });
        });
    }

    async function switchDeviceUser(deviceId: string, targetUser: string, customApp?: string): Promise<boolean> {
        try {
            const existingAdbFolders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'remote-adb') || [];
            if (existingAdbFolders.length > 0) {
                const manifestsMap: Record<string, any> = context.workspaceState.get('adbValidationManifests') || {};
                const primaryKey = `${existingAdbFolders[0].uri.authority}:${existingAdbFolders[0].uri.path}`;
                const primaryManifest = manifestsMap[primaryKey] || context.workspaceState.get<any>('adbValidationManifest');
                const workspaceSwitchCmd = primaryManifest?.switchCommand || { type: 'shell' };
                const workspaceEnv = workspaceSwitchCmd.type === 'custom' ? (workspaceSwitchCmd as any).pkgName : workspaceSwitchCmd.type;
                
                if (targetUser !== workspaceSwitchCmd.type || (targetUser === 'custom' && customApp?.trim() !== (workspaceSwitchCmd as any).pkgName)) {
                    const choice = await vscode.window.showWarningMessage(
                        `The open workspace is configured for the '${workspaceEnv}' user environment. Switching the device user to '${targetUser}' may break workspace file operations.`,
                        { modal: true },
                        'Switch Anyway'
                    );
                    if (choice !== 'Switch Anyway') {
                        return false;
                    }
                }
            }

            const shell = await connectionManager.getPersistentShell(deviceId);
            
            if (targetUser === 'shell') {
                let user = await shell.getCurrentUser();
                if (user.name === 'shell') {
                    return true;
                }
                await shell.sendRawCommand('exit');
                shell.refreshCurrentUser();
                shell.activeSwitchCommand = { type: 'shell' };
                vscode.commands.executeCommand('remote-adb.refreshDevices');
                return true;
            } else if (targetUser === 'root') {
                let user = await shell.getCurrentUser();
                if (user.name !== 'shell') {
                    await shell.sendRawCommand('exit');
                    shell.refreshCurrentUser();
                }
                await shell.sendRawCommand('su');
                shell.refreshCurrentUser();
                user = await shell.getCurrentUser();
                if (user.name !== 'root') {
                    await shell.sendRawCommand('exit');
                    vscode.window.showErrorMessage('Device is unrooted. Failed to switch to root.');
                    return false;
                } else {
                    shell.activeSwitchCommand = { type: 'root' };
                    vscode.commands.executeCommand('remote-adb.refreshDevices');
                    return true;
                }
            } else if (targetUser === 'termux') {
                const adbId = await connectionManager.resolveDeviceId(deviceId);
                return await setupAppEnvironment(adbId, 'com.termux', shell, './files/home/.raw');
            } else if (targetUser === 'custom') {
                if (!customApp || !customApp.trim()) {
                    vscode.window.showErrorMessage(`Failed to switch user: User is set to 'custom', but no package name ('customApp') was provided in configuration.`);
                    return false;
                }
                const adbId = await connectionManager.resolveDeviceId(deviceId);
                return await setupAppEnvironment(adbId, customApp.trim(), shell);
            }
            vscode.window.showErrorMessage(`Failed to switch user: Unknown target user '${targetUser}'.`);
            return false;
        } catch (error: any) {
            if (error.message && (error.message.includes('ADB shell closed') || error.message.includes('ADB shell is dead'))) {
                // ConnectionManager will handle the disconnect notification if it was a spontaneous drop.
                // We won't show the confusing 'unrooted/app not installed' message.
                return false;
            } else {
                vscode.window.showErrorMessage(`Failed to switch to ${targetUser}: ${error.message}`);
            }
            return false;
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserRoot', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const success = await switchDeviceUser(deviceItem.device.id, 'root');
        if (success) {
            vscode.window.showInformationMessage('Switched to root');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserTermux', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        await switchDeviceUser(deviceItem.device.id, 'termux');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserCustom', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const pkgName = await vscode.window.showInputBox({ prompt: 'Enter package name of debuggable app' });
        if (!pkgName) return;
        await switchDeviceUser(deviceItem.device.id, 'custom', pkgName);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserShell', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const shell = await connectionManager.getPersistentShell(deviceItem.device.id);
        const user = await shell.getCurrentUser();
        if (user.name === 'shell') {
            vscode.window.showInformationMessage('Already in shell environment');
            return;
        }
        await switchDeviceUser(deviceItem.device.id, 'shell');
        vscode.window.showInformationMessage('Switched back to shell environment');
    }));

    let openInCurrentWindowDisposable = vscode.commands.registerCommand('remote-adb.openInCurrentWindow', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${deviceItem.device.id}...`,
            cancellable: false
        }, async () => {
            connectionManager.setActiveDevice(deviceItem.device.id);
            updateStatusBar();
            vscode.commands.executeCommand('remote-adb.openFolder', deviceItem);
        });
    });

    let openInNewWindowDisposable = vscode.commands.registerCommand('remote-adb.openInNewWindow', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        connectionManager.setActiveDevice(deviceItem.device.id);
        updateStatusBar();
        
        const shell = await connectionManager.getPersistentShell(deviceItem.device.id);
        const pwd = await shell.executeCommand('pwd');
        let initialPath = pwd.trim() || '/';
        const user = await shell.getCurrentUser();
        if (shell.activeSwitchCommand?.type === 'termux') {
            initialPath = '/data/user/0/com.termux/files/home/';
        } else if (user.name === 'shell' && initialPath === '/') {
            initialPath = '/data/local/tmp';
        }
        const folderPath = await showFolderPicker(deviceItem.device.id, fsProvider, initialPath);
        if (folderPath) {
            // Stage 1-6: Target Path Validation Phase
            const manifest = await validationManager.validateWorkspace(deviceItem.device.id, folderPath);
            if (!manifest) {
                return;
            }

            const androidId = await connectionManager.resolveAndroidIdForDevice(deviceItem.device.id) || deviceItem.device.id;
            // For a new window, write it to globalStorageUri so the new window can pick it up
            const tempKey = `adbValidationManifest_${sanitizeKey(androidId)}_${sanitizeKey(folderPath)}.json`;
            const manifestUri = vscode.Uri.joinPath(context.globalStorageUri, tempKey);
            
            try {
                await vscode.workspace.fs.createDirectory(context.globalStorageUri);
                const data = new TextEncoder().encode(JSON.stringify(manifest));
                await vscode.workspace.fs.writeFile(manifestUri, data);
            } catch (e: any) {
                Logger.logError(`[Validation] Failed to save manifest to disk for new window: ${e.message}`);
            }

            // Small delay to ensure file system flush
            await new Promise(resolve => setTimeout(resolve, 500));

            const uri = vscode.Uri.parse(`remote-adb://${androidId}${folderPath}`);
            vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        }
    });

    let connectUsbDisposable = vscode.commands.registerCommand('remote-adb.connectUsb', async () => {
        try {
            const devices = await connectionManager.getDevices();
            if (devices.length === 0) {
                vscode.window.showInformationMessage('No ADB devices found.');
                return;
            }

            const items = devices.map(d => ({
                label: d.id,
                description: d.status
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a device to use'
            });

            if (selected) {
                connectionManager.setActiveDevice(selected.label);
                updateStatusBar();
                
                const openAction = 'Open Folder';
                vscode.window.showInformationMessage(`Selected device: ${selected.label}`, openAction)
                    .then(selection => {
                        if (selection === openAction) {
                            vscode.commands.executeCommand('remote-adb.openFolder');
                        }
                    });
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to list devices: ${error.message}`);
        }
    });

    const executeConnect = async (ipPort: string, targetUser?: string, customApp?: string) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Connecting to Android device...",
            cancellable: false
        }, async () => {
            const handleNotPaired = (target: string) => {
                const pairOption = 'Pair Device';
                vscode.window.showErrorMessage(`ADB Connect failed: ${target} is not paired.`, pairOption)
                    .then(sel => { if (sel === pairOption) {vscode.commands.executeCommand('remote-adb.pairTcpip');} });
            };

            const handleAuthFailure = (target: string) => {
                vscode.window.showWarningMessage(`ADB Connect: Failed to authenticate to ${target}. Please check the device screen and allow the USB debugging prompt.`);
            };

            try {
                const result = await connectionManager.connect(ipPort!);
                if (result.includes('failed to connect to')) {handleNotPaired(ipPort!);}
                else if (result.includes('failed to authenticate to')) {handleAuthFailure(ipPort!);}
                else if (result.includes('actively refused it') || result.includes('cannot connect to')) {
                    vscode.window.showErrorMessage(`ADB Connect failed: Connection refused.`);
                } else {
                    const isReady = await connectionManager.waitForDeviceReady(ipPort!, 10000);
                    if (!isReady) {
                        vscode.window.showWarningMessage(`Connected to ${ipPort!} but device is offline or unreachable.`);
                    }

                    connectionManager.setActiveDevice(ipPort!);
                    updateStatusBar();
                    
                    if (targetUser && isReady) {
                        const success = await switchDeviceUser(ipPort!, targetUser, customApp);
                        if (!success) {
                            vscode.window.showErrorMessage(`Connected, but failed to switch user to ${targetUser}`);
                        }
                    }

                    const openAction = 'Open Folder';
                    vscode.window.showInformationMessage(`ADB Connect: ${result}`, openAction).then(sel => {
                        if (sel === openAction) {vscode.commands.executeCommand('remote-adb.openFolder');}
                    });
                }
            } catch (error: any) {

                const msg = error.message || '';
                if (msg.includes('failed to connect to')) {handleNotPaired(ipPort!);}
                else if (msg.includes('failed to authenticate to')) {handleAuthFailure(ipPort!);}
                else if (msg.includes('actively refused it') || msg.includes('cannot connect to')) {vscode.window.showErrorMessage(`ADB Connect failed: Connection refused.`);}
                else {vscode.window.showErrorMessage(`Connection failed: ${msg}`);}
            }
        });
    };

    let connectTcpipDisposable = vscode.commands.registerCommand('remote-adb.connectTcpip', async () => {

        const savedConnections = vscode.workspace.getConfiguration().get<any[]>('remote-adb.savedConnections') || [];
        
        let ipPort: string | undefined;
        let targetUser: string | undefined;
        let customApp: string | undefined;

        if (savedConnections.length === 1) {
            ipPort = savedConnections[0].ipPort;
            targetUser = savedConnections[0].user;
            customApp = savedConnections[0].customApp;
        } else if (savedConnections.length > 1) {
            const items = savedConnections.map((conn: any) => ({
                label: conn.alias ? `$(device) ${conn.alias}` : `$(device) ${conn.ipPort}`,
                description: conn.user === 'custom' ? `(as ${conn.customApp})` : `(as ${conn.user})`,
                config: conn
            }));
            items.push({ label: '$(add) Enter Manually...', description: '', config: null });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a saved connection or enter manually'
            });

            if (!selected) { return; }

            if (selected.config) {
                ipPort = selected.config.ipPort;
                targetUser = selected.config.user;
                customApp = selected.config.customApp;
            }
        }

        if (ipPort) {
            ipPort = ipPort.trim();
            if (!ipPort.includes(':')) {
                ipPort += ':5555';
            }
        }

        if (!ipPort) {
            ipPort = await vscode.window.showInputBox({ 
                prompt: 'Enter Device IP and Port (e.g. 192.168.100.238:33935)',
                placeHolder: '192.168.100.238:33935',
                validateInput: (value) => {
                    if (!value) {return 'IP and Port cannot be empty';}
                    if (!value.includes(':')) {return 'Please enter IP and Port separated by a colon';}
                    return null;
                }
            });
        }
        
        if (!ipPort) {return;}

        await executeConnect(ipPort, targetUser, customApp);
    });

    let connectTcpipDirectDisposable = vscode.commands.registerCommand('remote-adb.connectTcpipDirect', async () => {
        let ipPort = await vscode.window.showInputBox({ 
            prompt: 'Enter Device IP and Port (e.g. 192.168.100.238:33935)',
            placeHolder: '192.168.100.238:33935',
            validateInput: (value) => {
                if (!value) {return 'IP and Port cannot be empty';}
                if (!value.includes(':')) {return 'Please enter IP and Port separated by a colon';}
                return null;
            }
        });
        
        if (ipPort) {
            ipPort = ipPort.trim();
            if (!ipPort.includes(':')) {
                ipPort += ':5555';
            }
            await executeConnect(ipPort);
        }
    });


    let pairTcpipDisposable = vscode.commands.registerCommand('remote-adb.pairTcpip', async () => {
        try {
            const ipPort = await vscode.window.showInputBox({ 
                prompt: 'Enter Device IP and Pairing Port (e.g. 192.168.100.238:33936)',
                placeHolder: '192.168.100.238:33936',
                validateInput: (value) => {
                    if (!value) { return 'IP and Port cannot be empty'; }
                    if (!value.includes(':')) {
                        return 'Please enter IP and Port separated by a colon';
                    }
                    return null;
                }
            });
            if (!ipPort) { return; }

            const code = await vscode.window.showInputBox({ prompt: 'Enter Pairing Code' });
            if (!code) { return; }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Pairing Android device...",
                cancellable: false
            }, async (progress) => {
                try {
                    const result = await connectionManager.pair(ipPort, code);
                    vscode.window.showInformationMessage(`ADB Pair: ${result}`);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Pairing failed: ${error.message}`);
                }
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Pairing failed: ${error.message}`);
        }
    });

    let showLogDisposable = vscode.commands.registerCommand('remote-adb.showLog', () => {
        Logger.show();
    });

    context.subscriptions.push(connectUsbDisposable);
    context.subscriptions.push(connectTcpipDisposable);
    context.subscriptions.push(connectTcpipDirectDisposable);
    context.subscriptions.push(pairTcpipDisposable);
    context.subscriptions.push(switchDeviceDisposable);
    context.subscriptions.push(openFolderDisposable);
    context.subscriptions.push(openInCurrentWindowDisposable);
    context.subscriptions.push(openInNewWindowDisposable);
    context.subscriptions.push(showLogDisposable);
}

export function deactivate() {
    // If we wanted to clean up persistent shells we could, but letting node exit works too.
}
