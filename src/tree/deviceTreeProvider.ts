import * as vscode from 'vscode';
import { ConnectionManager, AdbDevice } from '../adb/connectionManager';

export class DeviceTreeItem extends vscode.TreeItem {
    constructor(
        public readonly device: AdbDevice,
        public readonly username?: string,
        public readonly command?: vscode.Command
    ) {
        super(`${device.id} (${username || 'unknown'})`, vscode.TreeItemCollapsibleState.None);

        this.tooltip = `Device: ${device.id}\nStatus: ${device.status}${username ? '\nUser: ' + username : ''}`;
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
            const devices = await this.connectionManager.getDevices();
            const items = [];
            for (const device of devices) {
                // If device is offline/unauthorized, we might not be able to fetch the user safely without hanging or errors
                let username = 'shell';
                if (device.status === 'device') {
                    username = await this.connectionManager.getQuickUser(device.id);
                }
                items.push(new DeviceTreeItem(device, username));
            }
            return items;
        } catch (error) {
            vscode.window.showErrorMessage('Failed to fetch ADB devices');
            return [];
        }
    }
}
