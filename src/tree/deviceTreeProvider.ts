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
        this.iconPath = new vscode.ThemeIcon('device-mobile');
        
        if (device.status === 'device') {
            this.contextValue = 'adbDevice_device';
            this.description = device.status;
        } else if (device.status === 'unauthorized') {
            this.contextValue = 'adbDevice_unauthorized';
            this.description = 'unauthorized (Click to resolve)';
            this.command = {
                title: 'Handle Unauthorized Device',
                command: 'remote-adb.handleUnauthorizedDevice',
                arguments: [this]
            };
        } else if (device.status === 'offline') {
            this.contextValue = 'adbDevice_offline';
            this.description = 'offline (Click to resolve)';
            this.command = {
                title: 'Handle Offline Device',
                command: 'remote-adb.handleOfflineDevice',
                arguments: [this]
            };
        } else {
            this.contextValue = `adbDevice_${device.status}`;
            this.description = `${device.status} (Click to resolve)`;
        }
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
