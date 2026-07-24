import * as vscode from 'vscode';
import { PlatformToolsManager } from './adb/platformToolsManager';
import { ConnectionManager } from './adb/connectionManager';
import { ToyboxManager } from './adb/toyboxManager';
import { AdbFileSystemProvider } from './fs/adbFileSystemProvider';
import { Logger } from './logger';
import { DeviceTreeProvider, DeviceTreeItem } from './tree/deviceTreeProvider';
import { showFolderPicker } from './ui/folderPicker';
import { ValidationManager } from './adb/validationManager';

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context);
    console.log('Congratulations, your extension "remote-adb" is now active!');

    const toolsManager = new PlatformToolsManager(context);
    const connectionManager = new ConnectionManager(toolsManager);
    const toyboxManager = new ToyboxManager(toolsManager, context);

    const fsProvider = new AdbFileSystemProvider(connectionManager, toyboxManager);
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
        const folder = adbFolders[0];
        const deviceId = folder.uri.authority;
        const folderPath = folder.uri.path;
        
        const tempKey = `adbValidationManifest_${deviceId}_${folderPath}`;
        const globalManifest = context.globalState.get(tempKey);
        let manifestToLog = context.workspaceState.get('adbValidationManifest');
        
        if (globalManifest) {
            manifestToLog = globalManifest;
            // Adopt it into local workspace state and clear from global staging
            context.workspaceState.update('adbValidationManifest', globalManifest);
            context.globalState.update(tempKey, undefined);
        }
        
        if (manifestToLog) {
            Logger.logOutput(`[ADB Workspace Validation Manifest]\n${JSON.stringify(manifestToLog, null, 2)}`);
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

    // Command: Open Folder
    let openFolderDisposable = vscode.commands.registerCommand('remote-adb.openFolder', async (deviceItem?: DeviceTreeItem) => {
        let active = deviceItem ? deviceItem.device.id : connectionManager.getActiveDevice();
        if (!active) {
            vscode.window.showErrorMessage('No active device selected. Connect or select a device first.');
            return;
        }
        
        const folderPath = await showFolderPicker(active, fsProvider);
        if (folderPath) {
            // Stage 1-6: Target Path Validation Phase
            const manifest = await validationManager.validateWorkspace(active, folderPath);
            if (!manifest) {
                // User aborted or validation failed terminally
                return;
            }
            
            // Persist the manifest to global state for workspace reload scenarios
            const tempKey = `adbValidationManifest_${active}_${folderPath}`;
            await context.globalState.update(tempKey, manifest);
            
            // Also persist to current workspace state
            await context.workspaceState.update('adbValidationManifest', manifest);
            
            // Log immediately in case the window doesn't reload
            Logger.logOutput(`[ADB Workspace Validation Manifest]\n${JSON.stringify(manifest, null, 2)}`);

            vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
                0,
                { uri: vscode.Uri.parse(`remote-adb://${active}${folderPath}`), name: `ADB: ${active}${folderPath}` }
            );
        }
    });

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
        
        const folderPath = await showFolderPicker(deviceItem.device.id, fsProvider);
        if (folderPath) {
            // Stage 1-6: Target Path Validation Phase
            const manifest = await validationManager.validateWorkspace(deviceItem.device.id, folderPath);
            if (!manifest) {
                return;
            }

            // For a new window, global state might be needed to pass it across, but keeping it memory/workspaceState
            // Note: workspaceState is isolated per workspace, but new window doesn't exist yet.
            // We store it in global state temporarily with a key, and let the new window pick it up.
            const tempKey = `adbValidationManifest_${deviceItem.device.id}_${folderPath}`;
            await context.globalState.update(tempKey, manifest);

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
