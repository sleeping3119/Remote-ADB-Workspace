import * as vscode from 'vscode';
import { PlatformToolsManager } from './adb/platformToolsManager';
import { ConnectionManager } from './adb/connectionManager';
import { ToyboxManager } from './adb/toyboxManager';
import { CacheManager } from './fs/cacheManager';
import { AdbFileSystemProvider } from './fs/adbFileSystemProvider';
import { Logger } from './logger';
import { DeviceTreeProvider, DeviceTreeItem } from './tree/deviceTreeProvider';
import { showFolderPicker, triggerAcceptFolderPicker } from './ui/folderPicker';
import { ValidationManager } from './adb/validationManager';

export async function activate(context: vscode.ExtensionContext) {
    /** Strip characters that are illegal in Windows filenames: / \ : * ? " < > | */
    const sanitizeKey = (s: string) => s.replace(/\/+$/, '').replace(/[/\\:*?"<>|]/g, '_');
    Logger.initialize(context);
    console.log('Congratulations, your extension "remote-adb" is now active!');

    const toolsManager = new PlatformToolsManager(context);
    const connectionManager = new ConnectionManager(toolsManager);
    const toyboxManager = new ToyboxManager(toolsManager, context);
    const cacheManager = new CacheManager(context, connectionManager);

    const fsProvider = new AdbFileSystemProvider(connectionManager, toyboxManager, cacheManager);
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('remote-adb', fsProvider, { isCaseSensitive: true }));

    const validationManager = new ValidationManager(connectionManager, toyboxManager);

    const deviceTreeProvider = new DeviceTreeProvider(connectionManager);
    vscode.window.registerTreeDataProvider('remote-adb.devicesView', deviceTreeProvider);

    let refreshDevicesDisposable = vscode.commands.registerCommand('remote-adb.refreshDevices', () => {
        deviceTreeProvider.refresh();
    });
    context.subscriptions.push(refreshDevicesDisposable);

    // If we are opening a remote-adb workspace, retrieve the manifest and log it
    const adbFolders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'remote-adb');
    if (adbFolders && adbFolders.length > 0) {
        // Create an initialization lock IMMEDIATELY to block early FS operations
        let resolveInit!: () => void;
        const initPromise = new Promise<void>(r => resolveInit = r);
        connectionManager.setShellInitializing(initPromise);

        try {
            const folder = adbFolders[0];
            const deviceId = folder.uri.authority;
            const folderPath = folder.uri.path;
        
        const tempKey = `adbValidationManifest_${sanitizeKey(deviceId)}_${sanitizeKey(folderPath)}.json`;
        const manifestUri = vscode.Uri.joinPath(context.globalStorageUri, tempKey);
        
        Logger.logOutput(`[Extension Activate] Checking for manifest at: ${manifestUri.fsPath}`);
        
        let manifestToLog: any = undefined;
        try {
            const fs = require('fs');
            const data = await fs.promises.readFile(manifestUri.fsPath);
            const globalManifest = JSON.parse(data.toString());
            Logger.logOutput(`[Extension Activate] Found global manifest file. Adopting to workspace state.`);
            manifestToLog = globalManifest;
            
            // Adopt it into local workspace state and clear the file
            context.workspaceState.update('adbValidationManifest', globalManifest);
            try {
                await fs.promises.unlink(manifestUri.fsPath);
            } catch (e) {
                // Ignore delete errors
            }
        } catch (e) {
            // File not found, fallback to workspace state
            manifestToLog = context.workspaceState.get('adbValidationManifest');
            Logger.logOutput(`[Extension Activate] No global manifest file found. Checked workspaceState: ${manifestToLog ? 'Found' : 'Not Found'}`);
        }
        
        if (manifestToLog) {
            Logger.logOutput(`[ADB Workspace Validation Manifest]\n${JSON.stringify(manifestToLog, null, 2)}`);
            
            // Auto-restore environment if required
            const switchCmd = manifestToLog.privilegeContext?.switchCommand;
            if (switchCmd && switchCmd.type !== 'shell') {
                const shell = await connectionManager.getPersistentShell(deviceId);
                const currentUser = await shell.getCurrentUser();
                
                if (currentUser.name === 'shell') {
                    Logger.logOutput(`[Extension Activate] Restoring active user environment: ${switchCmd.type}`);
                    if (switchCmd.type === 'root') {
                        await shell.sendRawCommand('su');
                        shell.refreshCurrentUser();
                        shell.activeSwitchCommand = { type: 'root' };
                    } else if (switchCmd.type === 'termux') {
                        await setupAppEnvironment(deviceId, 'com.termux', shell, './files/home/.raw');
                    } else if (switchCmd.type === 'custom' && switchCmd.pkgName) {
                        await setupAppEnvironment(deviceId, switchCmd.pkgName, shell);
                    }
                }
            }
        } else {
            Logger.logOutput(`[Extension Activate] No manifest available to log.`);
        }
        
        // Trigger background cache initialization if manifest exists
        if (manifestToLog) {
            // We do not await this so it runs in the background
            cacheManager.initializeCache(deviceId, manifestToLog).catch(e => {
                Logger.logError(`[Extension Activate] Cache initialization failed: ${e}`);
            });
        }
        
        } finally {
            resolveInit();
        }
    }

    // Status Bar Item for device
    const deviceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    deviceStatusBar.command = 'remote-adb.switchDevice';
    context.subscriptions.push(deviceStatusBar);

    const updateStatusBar = () => {
        const active = connectionManager.getActiveDevice();
        if (active) {
            deviceStatusBar.text = `$(device-mobile) ADB: ${active}`;
            deviceStatusBar.show();
        } else {
            deviceStatusBar.hide();
        }
    };

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

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.acceptFolderPicker', () => {
        if (triggerAcceptFolderPicker) {
            triggerAcceptFolderPicker();
        }
    }));

    // Command: Open Folder
    let openFolderDisposable = vscode.commands.registerCommand('remote-adb.openFolder', async (deviceItem?: DeviceTreeItem) => {
        let active = deviceItem ? deviceItem.device.id : connectionManager.getActiveDevice();
        if (!active) {
            vscode.window.showErrorMessage('No active device selected. Connect or select a device first.');
            return;
        }
        
        const shell = await connectionManager.getPersistentShell(active);
        const pwd = await shell.executeCommand('pwd');
        let initialPath = pwd.trim() || '/';
        const user = await shell.getCurrentUser();
        if (user.name === 'shell' && initialPath === '/') {
            initialPath = '/data/local/tmp';
        }
        const folderPath = await showFolderPicker(active, fsProvider, initialPath);
        if (folderPath) {
            // Stage 1-6: Target Path Validation Phase
            const manifest = await validationManager.validateWorkspace(active, folderPath);
            if (!manifest) {
                // User aborted or validation failed terminally
                return;
            }
            
            // Persist the manifest to global storage for workspace reload scenarios
            const tempKey = `adbValidationManifest_${sanitizeKey(active)}_${sanitizeKey(folderPath)}.json`;
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
            
            // Also persist to current workspace state
            await context.workspaceState.update('adbValidationManifest', manifest);
            
            // Log immediately in case the window doesn't reload
            Logger.logOutput(`[ADB Workspace Validation Manifest]\n${JSON.stringify(manifest, null, 2)}`);

            // Give the extension host file system a moment to physically flush the JSON file 
            // before the brutal restart caused by updateWorkspaceFolders.
            await new Promise(resolve => setTimeout(resolve, 500));

            vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
                0,
                { uri: vscode.Uri.parse(`remote-adb://${active}${folderPath}`), name: `ADB: ${active}${folderPath}` }
            );
        }
    });

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
                
                const checkRaw = await shell.executeCommand('ls -A /data/local/tmp/.raw 2>/dev/null');
                if (checkRaw.trim()) {
                    const testLocal = await shell.executeCommand(`${targetFolder}/toybox --version`);
                    if (testLocal.includes('not found') || testLocal.includes('inaccessible') || testLocal.includes('No such file')) {
                        if (targetFolder.includes('/')) {
                            const parent = targetFolder.substring(0, targetFolder.lastIndexOf('/'));
                            await shell.executeCommand(`mkdir -p ${parent}`);
                        }
                        await shell.executeCommand(`mkdir -p ${targetFolder}`);
                        await shell.executeCommand(`cat /data/local/tmp/.raw/toybox > ${targetFolder}/toybox`);
                        await shell.executeCommand(`chmod 700 ${targetFolder}/toybox`);
                    }
                    toyboxManager.setToyboxPrefix(deviceId, user.name, `${targetFolder}/toybox`);
                } else {
                    toyboxManager.setToyboxPrefix(deviceId, user.name, 'toybox');
                }
                shell.activeSwitchCommand = { type: pkgName === 'com.termux' ? 'termux' : 'custom', pkgName };
                vscode.window.showInformationMessage(`Switched to ${pkgName}`);
                vscode.commands.executeCommand('remote-adb.refreshDevices');
                resolve(true);
            });
        });
    }

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserRoot', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const shell = await connectionManager.getPersistentShell(deviceItem.device.id);
        
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
            vscode.window.showErrorMessage('Failed to switch to root. Device might not be rooted.');
        } else {
            shell.activeSwitchCommand = { type: 'root' };
            vscode.window.showInformationMessage('Switched to root');
            vscode.commands.executeCommand('remote-adb.refreshDevices');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserTermux', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const shell = await connectionManager.getPersistentShell(deviceItem.device.id);
        await setupAppEnvironment(deviceItem.device.id, 'com.termux', shell, './files/home/.raw');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserCustom', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const pkgName = await vscode.window.showInputBox({ prompt: 'Enter package name of debuggable app' });
        if (!pkgName) return;
        const shell = await connectionManager.getPersistentShell(deviceItem.device.id);
        await setupAppEnvironment(deviceItem.device.id, pkgName, shell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remote-adb.switchUserShell', async (deviceItem: DeviceTreeItem) => {
        if (!deviceItem) return;
        const shell = await connectionManager.getPersistentShell(deviceItem.device.id);
        let user = await shell.getCurrentUser();
        if (user.name === 'shell') {
            vscode.window.showInformationMessage('Already in shell environment');
            return;
        }
        await shell.sendRawCommand('exit');
        shell.refreshCurrentUser();
        user = await shell.getCurrentUser();
        shell.activeSwitchCommand = { type: 'shell' };
        vscode.window.showInformationMessage('Switched to shell');
        vscode.commands.executeCommand('remote-adb.refreshDevices');
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
        if (user.name === 'shell' && initialPath === '/') {
            initialPath = '/data/local/tmp';
        }
        const folderPath = await showFolderPicker(deviceItem.device.id, fsProvider, initialPath);
        if (folderPath) {
            // Stage 1-6: Target Path Validation Phase
            const manifest = await validationManager.validateWorkspace(deviceItem.device.id, folderPath);
            if (!manifest) {
                return;
            }

            // For a new window, write it to globalStorageUri so the new window can pick it up
            const tempKey = `adbValidationManifest_${sanitizeKey(deviceItem.device.id)}_${sanitizeKey(folderPath)}.json`;
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

            const uri = vscode.Uri.parse(`remote-adb://${deviceItem.device.id}${folderPath}`);
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

    let connectTcpipDisposable = vscode.commands.registerCommand('remote-adb.connectTcpip', async () => {
        try {
            const usbResult = await connectionManager.tryUsb();
            if (usbResult && (usbResult.includes('restarting in USB mode') || usbResult.includes('already'))) {
                const devices = await connectionManager.getDevices();
                if (devices.length > 0) {
                    connectionManager.setActiveDevice(devices[0].id);
                    updateStatusBar();
                }
                const openAction = 'Open Folder';
                vscode.window.showInformationMessage(`Automatically connected via USB: ${usbResult}`, openAction).then(sel => {
                    if (sel === openAction) {vscode.commands.executeCommand('remote-adb.openFolder');}
                });
                return;
            }
        } catch (e) {}

        const ipPort = await vscode.window.showInputBox({ 
            prompt: 'Enter Device IP and Port (e.g. 192.168.100.238:33935)',
            placeHolder: '192.168.100.238:33935',
            validateInput: (value) => {
                if (!value) {return 'IP and Port cannot be empty';}
                if (!value.includes(':')) {return 'Please enter IP and Port separated by a colon';}
                return null;
            }
        });
        if (!ipPort) {return;}

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

            try {
                const result = await connectionManager.connect(ipPort);
                if (result.includes('failed to connect to')) {handleNotPaired(ipPort);}
                else if (result.includes('actively refused it') || result.includes('cannot connect to')) {
                    vscode.window.showErrorMessage(`ADB Connect failed: Connection refused.`);
                } else {
                    connectionManager.setActiveDevice(ipPort);
                    updateStatusBar();
                    const openAction = 'Open Folder';
                    vscode.window.showInformationMessage(`ADB Connect: ${result}`, openAction).then(sel => {
                        if (sel === openAction) {vscode.commands.executeCommand('remote-adb.openFolder');}
                    });
                }
            } catch (error: any) {
                const msg = error.message || '';
                if (msg.includes('failed to connect to')) {handleNotPaired(ipPort);}
                else if (msg.includes('actively refused it') || msg.includes('cannot connect to')) {vscode.window.showErrorMessage(`ADB Connect failed: Connection refused.`);}
                else {vscode.window.showErrorMessage(`Connection failed: ${msg}`);}
            }
        });
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
