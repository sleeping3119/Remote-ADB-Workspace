import * as vscode from 'vscode';
import { AdbFileSystemProvider } from '../fs/adbFileSystemProvider';

export let triggerAcceptFilePicker: (() => void) | undefined;

interface FileQuickPickItem extends vscode.QuickPickItem {
    isDir: boolean;
    fullPath: string;
}

export async function showFilePicker(
    deviceId: string,
    fsProvider: AdbFileSystemProvider,
    initialPath: string = '/'
): Promise<string | undefined> {
    return new Promise((resolve) => {
        const quickPick = vscode.window.createQuickPick<FileQuickPickItem>();
        quickPick.title = 'Remote ADB: Select File';
        quickPick.placeholder = 'Type an absolute path to navigate or select a file...';
        quickPick.ignoreFocusOut = false;
        quickPick.matchOnDescription = true;

        let currentLoadedPath = initialPath;
        if (!currentLoadedPath.startsWith('/')) { currentLoadedPath = '/' + currentLoadedPath; }
        if (!currentLoadedPath.endsWith('/')) { currentLoadedPath += '/'; }

        let loadCounter = 0;

        const loadDirectory = async (dirPath: string, updateInputBox: boolean = true) => {
            const currentCounter = ++loadCounter;
            quickPick.busy = true;
            
            if (!dirPath.startsWith('/')) { dirPath = '/' + dirPath; }
            if (!dirPath.endsWith('/')) { dirPath += '/'; }
            
            if (updateInputBox) {
                quickPick.value = dirPath;
            }
            currentLoadedPath = dirPath;
            
            try {
                const uri = vscode.Uri.parse(`remote-adb://${deviceId}${dirPath}`);
                const entries = await fsProvider.readFilePickerDirectoryWithPermissions(uri);

                if (currentCounter !== loadCounter) { return; } // A newer request was fired

                const items: FileQuickPickItem[] = [];

                if (dirPath !== '/') {
                    const parts = dirPath.split('/').filter(Boolean);
                    parts.pop();
                    const parentDir = '/' + parts.join('/') + (parts.length > 0 ? '/' : '');
                    items.push({
                        label: '$(folder) ..',
                        description: parentDir,
                        alwaysShow: true,
                        isDir: true,
                        fullPath: parentDir
                    });
                }

                // Sort: directories first, then files, both alphabetically
                const sortedEntries = entries.sort((a, b) => {
                    const aIsDir = a.type === vscode.FileType.Directory;
                    const bIsDir = b.type === vscode.FileType.Directory;
                    if (aIsDir && !bIsDir) return -1;
                    if (!aIsDir && bIsDir) return 1;
                    return a.name.localeCompare(b.name);
                });

                for (const entry of sortedEntries) {
                    const isDir = entry.type === vscode.FileType.Directory;
                    const baseIcon = isDir ? '$(folder)' : '$(file)';
                    const icon = entry.accessible ? baseIcon : '$(lock)';
                    items.push({
                        label: `${icon} ${entry.name}`,
                        description: `${dirPath}${entry.name}`,
                        isDir: isDir,
                        fullPath: `${dirPath}${entry.name}`
                    });
                }
                
                quickPick.items = items;
            } catch (error: any) {
                if (currentCounter !== loadCounter) { return; }

                if (updateInputBox) {
                    if (error.code === 'NoPermissions' || (error.message && error.message.includes('Permission denied'))) {
                        quickPick.items = [{
                            label: '$(error) Permission Denied',
                            description: `Cannot access ${dirPath}`,
                            alwaysShow: true,
                            isDir: true,
                            fullPath: dirPath
                        }];
                    } else {
                        quickPick.items = [{
                            label: '$(error) Error',
                            description: `Failed to list: ${error.message || ''}`,
                            alwaysShow: true,
                            isDir: true,
                            fullPath: dirPath
                        }];
                    }
                } else {
                    quickPick.items = [];
                }
            } finally {
                if (currentCounter === loadCounter) {
                    quickPick.busy = false;
                }
            }
        };

        quickPick.onDidChangeValue(async (value) => {
            if (value.endsWith('/') && value !== currentLoadedPath) {
                await loadDirectory(value, true);
            } else if (!value.endsWith('/')) {
                const lastSlashIndex = value.lastIndexOf('/');
                if (lastSlashIndex >= 0) {
                    const targetDir = value.substring(0, lastSlashIndex + 1);
                    if (targetDir !== currentLoadedPath) {
                        await loadDirectory(targetDir, false);
                    }
                }
            }
        });

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0] || quickPick.activeItems[0];
            const typedValue = quickPick.value;

            if (selected) {
                if (selected.label.includes('$(error)')) {
                    const parts = currentLoadedPath.split('/').filter(Boolean);
                    if (parts.length > 0) {
                        parts.pop();
                        const fallbackPath = '/' + parts.join('/') + (parts.length > 0 ? '/' : '');
                        await loadDirectory(fallbackPath, true);
                    } else if (currentLoadedPath !== '/') {
                        await loadDirectory('/', true);
                    }
                    return;
                }

                if (selected.isDir) {
                    await loadDirectory(selected.fullPath + '/', true);
                } else {
                    quickPick.hide();
                    resolve(selected.fullPath);
                }
            } else if (typedValue && typedValue !== currentLoadedPath) {
                if (typedValue.endsWith('/')) {
                    await loadDirectory(typedValue, true);
                } else {
                    quickPick.hide();
                    resolve(typedValue);
                }
            }
        });

        triggerAcceptFilePicker = () => {
            const selected = quickPick.selectedItems[0] || quickPick.activeItems[0];
            const typedValue = quickPick.value;
            if (selected && !selected.isDir && !selected.label.includes('$(error)')) {
                quickPick.hide();
                resolve(selected.fullPath);
            } else if (typedValue && !typedValue.endsWith('/')) {
                quickPick.hide();
                resolve(typedValue);
            }
        };

        quickPick.onDidHide(() => {
            triggerAcceptFilePicker = undefined;
            vscode.commands.executeCommand('setContext', 'remoteAdbFilePickerActive', false);
            quickPick.dispose();
            resolve(undefined);
        });

        vscode.commands.executeCommand('setContext', 'remoteAdbFilePickerActive', true);

        loadDirectory(currentLoadedPath, true);
        quickPick.show();
    });
}
