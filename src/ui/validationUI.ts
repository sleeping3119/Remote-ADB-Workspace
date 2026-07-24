import * as vscode from 'vscode';
import { NodeStatus } from '../adb/validationManager';

/**
 * Validation UI — Pre-flight Permission Summary
 *
 * Design Notes:
 * - The target folder itself only needs r-x to be opened as a workspace root.
 *   Whether the user can READ or WRITE files inside it depends on each individual
 *   file/dir's permissions and the user's ownership or group membership.
 * - If root is available (isRootAvailable=true), chmod is run via `su -c chmod a+<bits>`.
 *   This escalates permissions universally (all users) without checking group membership,
 *   which is intentional for a dev workspace where root intent implies full control.
 * - If the user is the owner but has no root, only owner bits are changed via `chmod u+<bits>`.
 *   This is the safe default to avoid unintentionally opening files to other processes.
 *
 * TODO(post-mvp):
 * - UI Polish: Show a hierarchical tree view of permissions with columns:
 *     [path] | [current perms] | [perms after fix] | [action]
 *   Similar to `ls -la` but in a VS Code WebView or TreeView.
 * - Root Fix: If a file is still blocked even after the chmod was applied with `su`,
 *   investigate if SELinux context or Android Scoped Storage is the cause and
 *   surface the specific denial reason to the user.
 * - Minimum Permissions with su: When fixing with root, calculate the minimum
 *   necessary permissions (e.g. just +r for read-only, +rx for directories)
 *   instead of a blanket a+rwx, so we don't over-expose sensitive files.
 */

export interface ValidationGroup {
    inaccessible: NodeStatus[];
    readOnly: NodeStatus[];
    targetPath: string;
}

export interface RemediationChoice {
    action: 'fix_all' | 'fix_selected' | 'skip' | 'abort';
    applyRecursively?: boolean;
    selectedNodesToFix?: NodeStatus[];
}

export async function showValidationSummaryUI(group: ValidationGroup): Promise<RemediationChoice | undefined> {
    return new Promise((resolve) => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Pre-flight Validation Summary';
        quickPick.placeholder = 'Some items have restricted permissions. Select an action...';
        quickPick.ignoreFocusOut = true;

        // Guard flag: once an action is committed, prevent onDidHide from resolving undefined
        let committed = false;
        const commit = (choice: RemediationChoice | undefined) => {
            committed = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(choice);
        };

        const items: vscode.QuickPickItem[] = [];

        // Information Display
        if (group.inaccessible.length > 0) {
            items.push({
                label: `$(error) You will not be able to access or copy these items (${group.inaccessible.length})`,
                kind: vscode.QuickPickItemKind.Separator
            });
            for (const node of group.inaccessible) {
                items.push({
                    label: `  ${node.isDir ? '$(folder)' : '$(file)'} ${node.path}`,
                    description: node.isRemediable ? 'Click to fix permissions' : 'Terminal (Cannot Fix)',
                    node: node
                } as vscode.QuickPickItem & { node: NodeStatus });
            }
        }

        if (group.readOnly.length > 0) {
            items.push({
                label: `$(warning) You will be able to copy, but NOT modify these items (${group.readOnly.length})`,
                kind: vscode.QuickPickItemKind.Separator
            });
            for (const node of group.readOnly) {
                items.push({
                    label: `  ${node.isDir ? '$(folder)' : '$(file)'} ${node.path}`,
                    description: node.isRemediable ? 'Click to fix permissions' : 'Terminal (Cannot Fix)',
                    node: node
                } as vscode.QuickPickItem & { node: NodeStatus });
            }
        }

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

        const fixAllItem: vscode.QuickPickItem = {
            label: '$(wrench) Fix All Remediable Items',
            description: 'Attempt to apply necessary permissions to all fixable nodes',
            detail: 'Applies w for Read-Only, r-x/r for Inaccessible'
        };
        const skipItem: vscode.QuickPickItem = {
            label: '$(debug-step-over) Skip Unfixable/Blocked Items',
            description: 'Exclude them from the workspace and proceed'
        };
        const abortItem: vscode.QuickPickItem = {
            label: '$(close) Abort Workspace Opening',
            description: 'Do not open this folder'
        };

        quickPick.items = [...items, fixAllItem, skipItem, abortItem];

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0] as vscode.QuickPickItem & { node?: NodeStatus };

            if (selected === fixAllItem) {
                // Mark committed BEFORE hide so onDidHide doesn't resolve undefined
                committed = true;
                quickPick.hide();
                const hasDirs = [...group.inaccessible, ...group.readOnly].some(n => n.isRemediable && n.isDir);
                let applyRecursively = false;
                if (hasDirs) {
                    const scope = await vscode.window.showQuickPick([
                        { label: 'Apply Recursively', description: 'To folder and all nested child items' },
                        { label: 'Apply to Folder Only', description: 'Do not touch children' }
                    ], { placeHolder: 'Permission Fix Scope', ignoreFocusOut: true });

                    if (!scope) { commit(undefined); return; }
                    applyRecursively = scope.label === 'Apply Recursively';
                }
                commit({ action: 'fix_all', applyRecursively });

            } else if (selected === skipItem) {
                commit({ action: 'skip' });

            } else if (selected === abortItem) {
                commit({ action: 'abort' });

            } else if (selected && selected.node) {
                const clickedNode = selected.node;

                if (!clickedNode.isRemediable) {
                    // Info message but keep the quickpick open
                    vscode.window.showInformationMessage(
                        `Cannot fix "${clickedNode.path}": you don't own it and root is not available.`
                    );
                    return; // Do NOT commit — keep the UI open
                }

                // Mark committed BEFORE hide so onDidHide doesn't resolve undefined
                committed = true;
                quickPick.hide();
                let applyRecursively = false;
                if (clickedNode.isDir) {
                    const scope = await vscode.window.showQuickPick([
                        { label: 'Apply Recursively', description: 'To folder and all nested child items' },
                        { label: 'Apply to Folder Only', description: 'Do not touch children' }
                    ], { placeHolder: `Scope for: ${clickedNode.path}`, ignoreFocusOut: true });

                    if (!scope) { commit(undefined); return; }
                    applyRecursively = scope.label === 'Apply Recursively';
                }
                commit({ action: 'fix_selected', applyRecursively, selectedNodesToFix: [clickedNode] });
            }
        });

        quickPick.onDidHide(() => {
            if (!committed) {
                quickPick.dispose();
                resolve(undefined);
            }
        });

        quickPick.show();
    });
}
