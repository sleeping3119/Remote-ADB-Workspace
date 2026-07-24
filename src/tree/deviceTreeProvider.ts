import * as vscode from 'vscode';
import { ConnectionManager, AdbDevice } from '../adb/connectionManager';

export class DeviceTreeItem extends vscode.TreeItem {
    constructor(
        public readonly device: AdbDevice,
        public readonly command?: vscode.Command
    ) {
        super(device.id, vscode.TreeItemCollapsibleState.None);

        this.tooltip = `Device: ${device.id}\nStatus: ${device.status}`;
        this.description = device.status;
        this.iconPath = new vscode.ThemeIcon('device-mobile');
        
        // Context value for context menus
        this.contextValue = 'adbDevice';
    }
}

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DeviceTreeItem | undefined | void> = new vscode.EventEmitter<DeviceTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<DeviceTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private connectionManager: ConnectionManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DeviceTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DeviceTreeItem): Promise<DeviceTreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        try {
            // Force fetch latest devices if needed, but connectionManager.getDevices caches if there's a pending call.
            // We should ideally fetch real devices. Wait, ConnectionManager caches the promise of getDevices, but only while pending.
            // So it does a real fetch each time.
            const devices = await this.connectionManager.getDevices();
            return devices.map(device => new DeviceTreeItem(device));
        } catch (error) {
            vscode.window.showErrorMessage('Failed to fetch ADB devices');
            return [];
        }
    }
}
