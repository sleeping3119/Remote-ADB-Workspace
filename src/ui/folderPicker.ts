import * as vscode from 'vscode';
import { AdbFileSystemProvider } from '../fs/adbFileSystemProvider';

export async function showFolderPicker(
    deviceId: string,
    fsProvider: AdbFileSystemProvider,
    initialPath: string = '/'
): Promise<string | undefined> {
    return new Promise((resolve) => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Remote ADB: Select Folder';
        quickPick.placeholder = 'Type an absolute path to navigate...';
        quickPick.ignoreFocusOut = true;
        quickPick.matchOnDescription = true;

        const okButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('check'),
            tooltip: 'Select and Open this Folder'
        };
        
        quickPick.buttons = [okButton];

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
                const entries = await fsProvider.readDirectoryWithPermissions(uri);

                if (currentCounter !== loadCounter) { return; } // A newer request was fired

                const items: vscode.QuickPickItem[] = [];

                if (dirPath !== '/') {
                    const parts = dirPath.split('/').filter(Boolean);
                    parts.pop();
                    const parentDir = '/' + parts.join('/') + (parts.length > 0 ? '/' : '');
                    items.push({
                        label: '$(folder) ..',
                        description: parentDir,
                        alwaysShow: true
                    });
                }

                const dirs = entries.sort((a, b) => a.name.localeCompare(b.name));

                for (const dir of dirs) {
                    const icon = dir.accessible ? '$(folder)' : '$(lock)';
                    items.push({
                        label: `${icon} ${dir.name}`,
                        description: `${dirPath}${dir.name}`
                    });
                }
                
                quickPick.items = items;
            } catch (error: any) {
                if (currentCounter !== loadCounter) { return; }

                if (updateInputBox) {
                    // Show error directly in the list instead of an empty list
                    if (error.code === 'NoPermissions' || (error.message && error.message.includes('Permission denied'))) {
                        quickPick.items = [{
                            label: '$(error) Permission Denied',
                            description: `Cannot access ${dirPath}`,
                            alwaysShow: true
                        }];
                    } else {
                        quickPick.items = [{
                            label: '$(error) Error',
                            description: `Failed to list: ${error.message || ''}`,
                            alwaysShow: true
                        }];
                    }
                    
                    // Intelligent fallback logic: try parent after a small delay if they pressed Enter,
                    // actually the user wants the error shown in the list! So we don't auto-fallback immediately,
                    // we just show the error.
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
            // Auto-navigate if the user explicitly types a trailing slash
            if (value.endsWith('/') && value !== currentLoadedPath) {
                await loadDirectory(value, true);
            } else if (!value.endsWith('/')) {
                // If user is typing/backspacing mid-path, silently load the base directory
                // so that subdirectories instantly appear in the filtered list
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
                    // User selected the error item. Execute fallback to parent directory.
                    const parts = currentLoadedPath.split('/').filter(Boolean);
                    if (parts.length > 0) {
                        parts.pop(); // remove invalid/denied part
                        const fallbackPath = '/' + parts.join('/') + (parts.length > 0 ? '/' : '');
                        await loadDirectory(fallbackPath, true);
                    } else if (currentLoadedPath !== '/') {
                        await loadDirectory('/', true);
                    }
                    return;
                }

                if (selected.label === '$(folder) ..') {
                    await loadDirectory(selected.description || '/', true);
                } else {
                    await loadDirectory(selected.description + '/', true);
                }
            } else if (typedValue && typedValue !== currentLoadedPath) {
                // If they typed a path directly and hit enter, navigate into it
                await loadDirectory(typedValue, true);
            }
        });

        quickPick.onDidTriggerButton(async (button) => {
            if (button === okButton) {
                const typedValue = quickPick.value;
                quickPick.busy = true;
                try {
                    const checkPath = typedValue.endsWith('/') ? typedValue : typedValue + '/';
                    const uri = vscode.Uri.parse(`remote-adb://${deviceId}${checkPath}`);
                    
                    // Explicitly verify read/execute permissions for final workspace folder
                    const isAccessible = await fsProvider.isWorkspaceAccessible(uri);
                    
                    if (isAccessible) {
                        quickPick.hide();
                        resolve(checkPath);
                    } else {
                        vscode.window.showErrorMessage(`Permission denied or invalid directory: ${typedValue}`);
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Error checking path: ${typedValue}`);
                } finally {
                    quickPick.busy = false;
                }
            }
        });

        quickPick.onDidHide(() => {
            quickPick.dispose();
            resolve(undefined);
        });

        loadDirectory(currentLoadedPath, true);
        quickPick.show();
    });
}
