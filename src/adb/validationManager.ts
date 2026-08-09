import * as vscode from 'vscode';
import { ConnectionManager, PersistentAdbShell } from './connectionManager';
import { ToyboxManager } from './toyboxManager';
import { showValidationSummaryUI, RemediationChoice, ValidationGroup } from '../ui/validationUI';
import { Logger } from '../logger';

/**
 * ValidationManager — Target Path Validation Pipeline
 *
 * Orchestrates the 6-stage validation process that runs between a user selecting
 * a folder on the Android device and the VS Code workspace being opened.
 *
 * Permission Model:
 * - Stage 1 (Gatekeeper): The target folder itself is checked for r-x.
 *   This is the only hard prerequisite: without it the folder cannot be listed at all.
 *   Read/write access to files inside is a separate concern determined per-item.
 *
 * - Stage 5 (Remediation chmod behaviour):
 *   a) Root available (isRootAvailable=true):
 *      Runs `su -c chmod a+<bits> <path>` — escalates to all-user permissions
 *      WITHOUT checking group membership. This is intentional; root intent in a
 *      dev context implies broad access. Minimum bits needed are applied.
 *   b) Owner, no root:
 *      Runs `chmod u+<bits> <path>` — only changes the owner (u) bits.
 *      Safe default: does not expose the file to other system processes.
 *   c) Not owner, no root:
 *      isRemediable=false. No chmod is attempted. User must Skip or Abort.
 *
 * TODO(post-mvp):
 * - Minimum Permissions with su: Instead of a+rwx, grant only the minimum bits
 *   needed per path (e.g. +r for read-only files, +rx for directories).
 * - Root SELinux/Scoped Storage diagnosis: If chmod succeeds but the re-check still
 *   fails, probe with `adb shell ls -laZ` to surface the SELinux context label
 *   and explain why even root cannot override it.
 */

export interface ValidationManifest {
    workspaceRoot: string;
    fullAccess: string[];
    readOnly: string[];
    skipped: string[];
    privilegeContext: {
        user: string;
        groups: string[];
        isRootAvailable: boolean;
        switchCommand?: { type: 'root' | 'termux' | 'custom' | 'shell', pkgName?: string };
    };
}

export interface NodeStatus {
    path: string;
    isDir: boolean;
    isReadable: boolean;
    isWritable: boolean;
    isExecutable: boolean;
    isOwned: boolean;
    category: 'FULL_ACCESS' | 'READ_ONLY' | 'INACCESSIBLE';
    isRemediable: boolean;
}

export class ValidationManager {
    private connectionManager: ConnectionManager;
    private toyboxManager: ToyboxManager;


    constructor(connectionManager: ConnectionManager, toyboxManager: ToyboxManager) {
        this.connectionManager = connectionManager;
        this.toyboxManager = toyboxManager;
    }

    /**
     * Entry point for single file validation.
     * Triggers when the user selects a file from the file picker.
     */
    public async validateFile(deviceId: string, targetPath: string): Promise<boolean> {
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);

        let isRootAvailable = false;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Validating ADB File...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Checking privileges...' });
            try {
                const suCheck = await shell.executeCommand(`su -c id 2>/dev/null`);
                if (suCheck.includes('uid=0(root)')) {
                    isRootAvailable = true;
                }
            } catch (e) {
                // su not available
            }
        });

        // Check if file is readable and writable
        const checkCmd = `[ -r "${targetPath}" ] && [ -w "${targetPath}" ] && echo "RW" || ([ -r "${targetPath}" ] && echo "R" || echo "FAIL")`;
        const gateCheck = await shell.executeCommand(checkCmd);
        const result = gateCheck.trim();

        if (result !== 'RW') {
            const isTargetOwned = await this.checkOwnership(shell, prefix, targetPath, currentUser.name);
            
            const actionLabel = 'Attempt Fix';
            const skipLabel = 'Skip / Open Anyway';
            const cancelLabel = 'Abort';
            let message = result === 'R' 
                ? `The selected file (${targetPath}) is read-only. Would you like to attempt to make it writable?` 
                : `The selected file (${targetPath}) lacks read access. Would you like to attempt to fix it?`;
            
            const actions = [];
            if (isTargetOwned || isRootAvailable) {
                actions.push(actionLabel);
            }
            actions.push(skipLabel);
            actions.push(cancelLabel);

            const userChoice = await vscode.window.showWarningMessage(message, { modal: true }, ...actions);
            
            if (userChoice === actionLabel) {
                // Attempt to fix
                const chmodCmd = isRootAvailable 
                    ? `su -c chmod a+rw "${targetPath}"` 
                    : `${prefix} chmod a+rw "${targetPath}"`;
                await shell.executeCommand(chmodCmd);
                
                // Re-check read permission as a baseline
                const recheck = await shell.executeCommand(`[ -r "${targetPath}" ] && echo "OK" || echo "FAIL"`);
                if (recheck.trim() !== 'OK') {
                    vscode.window.showErrorMessage(`Target file (${targetPath}) is blocked by system security policy and permissions cannot be changed.`);
                    // Even if blocked, if they chose to fix we fail if it still can't be read.
                    return false;
                }
                return true;
            } else if (userChoice === skipLabel) {
                return true;
            } else {
                return false; // Abort
            }
        }

        return true;
    }

    /**
     * Main entry point for the target path validation pipeline.
     * Triggers immediately after the user selects a folder.
     */
    public async validateWorkspace(deviceId: string, targetPath: string): Promise<ValidationManifest | undefined> {
        const shell = await this.connectionManager.getPersistentShell(deviceId);
        const currentUser = await shell.getCurrentUser();
        const prefix = await this.toyboxManager.getToyboxPrefix(deviceId, currentUser.name);

        // Stage 0: Privilege Discovery
        let isRootAvailable = false;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Validating ADB Workspace...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Checking privileges...' });
            try {
                const suCheck = await shell.executeCommand(`su -c id 2>/dev/null`);
                if (suCheck.includes('uid=0(root)')) {
                    isRootAvailable = true;
                }
            } catch (e) {
                // su not available
            }
        });

        // Stage 1: Target Folder Gatekeeper Check (!p Gatekeeper)
        const gateCheck = await shell.executeCommand(`[ -r "${targetPath}" ] && [ -x "${targetPath}" ] && echo "OK" || echo "FAIL"`);
        if (gateCheck.trim() !== 'OK') {
            // Target folder lacks permissions
            const isTargetOwned = await this.checkOwnership(shell, prefix, targetPath, currentUser.name);
            
            const actionLabel = 'Attempt Fix';
            const cancelLabel = 'Abort';
            let message = `The selected folder (${targetPath}) lacks permissions (needs r-x) to be opened as a workspace.`;
            
            const actions = [];
            if (isTargetOwned || isRootAvailable) {
                actions.push(actionLabel);
            }
            actions.push(cancelLabel);

            const userChoice = await vscode.window.showWarningMessage(message, { modal: true }, ...actions);
            
            if (userChoice === actionLabel) {
                // Attempt to fix
                const chmodCmd = isRootAvailable 
                    ? `su -c chmod a+rx "${targetPath}"` 
                    : `${prefix} chmod a+rx "${targetPath}"`;
                await shell.executeCommand(chmodCmd);
                
                // Re-check
                const recheck = await shell.executeCommand(`[ -r "${targetPath}" ] && [ -x "${targetPath}" ] && echo "OK" || echo "FAIL"`);
                if (recheck.trim() !== 'OK') {
                    vscode.window.showErrorMessage(`Target folder (${targetPath}) is blocked by system security policy and permissions cannot be changed.`);
                    return undefined;
                }
            } else {
                return undefined; // Abort
            }
        }

        // Stage 2 & 3: Workspace Traversal & System Policy Testing
        let nodes: NodeStatus[] = [];
        let acceptedPaths = new Set<string>();
        let attemptedPaths = new Set<string>(); // Tracks paths where chmod was attempted and failed
        let isFirstScan = true;

        while (true) {
            let scanAborted = false;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Scanning workspace contents...',
                cancellable: true
            }, async (progress, token) => {
                // Threshold Check only on first loop
                if (isFirstScan) {
                    isFirstScan = false;
                    const countStr = await shell.executeCommand(`${prefix} find "${targetPath}" 2>/dev/null | wc -l`);
                    const fileCount = parseInt(countStr.trim(), 10);
                    
                    if (fileCount > 10000) {
                        const proceed = await vscode.window.showWarningMessage(
                            `This folder contains ${fileCount} items. Scanning permissions might take a while. Proceed?`,
                            'Proceed', 'Cancel'
                        );
                        if (proceed !== 'Proceed') {
                            scanAborted = true;
                            return;
                        }
                    }
                }

                if (!scanAborted) {
                    nodes = await this.traverseAndEvaluate(shell, prefix, targetPath, isRootAvailable);
                }
                
                if (token.isCancellationRequested) scanAborted = true;
            });
            
            if (scanAborted) return undefined;

            const inaccessible: NodeStatus[] = [];
            const readOnly: NodeStatus[] = [];

            for (const node of nodes) {
                if (acceptedPaths.has(node.path)) continue;

                // If this path was already attempted and failed, mark it as non-remediable
                // so it still shows in the UI but can't be retried
                if (attemptedPaths.has(node.path)) {
                    node.isRemediable = false;
                }

                if (node.category === 'INACCESSIBLE') inaccessible.push(node);
                else if (node.category === 'READ_ONLY') readOnly.push(node);
            }

            if (inaccessible.length === 0 && readOnly.length === 0) {
                break; // All clear!
            }

            // Stage 4: Pre-flight Summary UI
            const uiResult = await showValidationSummaryUI({
                inaccessible,
                readOnly,
                targetPath
            });

            if (!uiResult || uiResult.action === 'abort') {
                return undefined;
            }

            if (uiResult.action === 'skip') {
                // User accepts the current state for all remaining items
                for (const node of inaccessible) acceptedPaths.add(node.path);
                for (const node of readOnly) acceptedPaths.add(node.path);
                break;
            }

            // Stage 5: Remediation Execution
            if (uiResult.action === 'fix_all' || uiResult.action === 'fix_selected') {
                const nodesToFix = uiResult.action === 'fix_all' 
                    ? [...inaccessible, ...readOnly].filter(n => n.isRemediable)
                    : uiResult.selectedNodesToFix || [];

                // If they chose fix_all, unselected items (unfixable) are accepted.
                // If they chose fix_selected, we ONLY focus on the selected item, rest stay pending!
                if (uiResult.action === 'fix_all') {
                    for (const node of [...inaccessible, ...readOnly]) {
                        if (!nodesToFix.includes(node)) {
                            acceptedPaths.add(node.path);
                        }
                    }
                }

                if (nodesToFix.length === 0) {
                    // Nothing to fix — loop will re-show UI with same items (all non-remediable)
                    continue;
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Applying permissions...',
                    cancellable: false
                }, async () => {
                    for (const node of nodesToFix) {
                        const chmodCmd = this.buildChmodCommand(node, uiResult.applyRecursively || false, isRootAvailable, prefix);
                        Logger.logOutput(`[Validation] Running: ${chmodCmd}`);
                        await shell.executeCommand(chmodCmd);

                        // Re-check
                        const recheckCmd = `[ -d "${node.path}" ] && d=1 || d=0; [ -r "${node.path}" ] && r=1 || r=0; [ -w "${node.path}" ] && w=1 || w=0; [ -x "${node.path}" ] && x=1 || x=0; echo "$d|$r|$w|$x"`;
                        const recheckOut = await shell.executeCommand(recheckCmd);
                        Logger.logOutput(`[Validation] Re-check ${node.path}: ${recheckOut.trim()}`);
                        
                        const parts = recheckOut.trim().split('|');
                        const d = parts[0] === '1';
                        const r = parts[1] === '1';
                        const w = parts[2] === '1';
                        const x = parts[3] === '1';
                        
                        let isFullAccess = false;

                        if (d) {
                            if (r && w && x) isFullAccess = true;
                        } else {
                            if (r && w) isFullAccess = true;
                        }

                        if (!isFullAccess) {
                            // Mark as attempted so it shows as non-remediable on next loop
                            attemptedPaths.add(node.path);
                            Logger.logOutput(`[Validation] Fix failed for ${node.path} — will show as non-remediable`);
                        }
                    }
                });
                // Loop restarts: re-scans and re-shows UI.
                // Fixed nodes will now pass. Failed nodes show as non-remediable.
            }
        }

        // Stage 6: Validation Manifest Construction
        const finalFullAccess: string[] = [];
        const finalReadOnly: string[] = [];
        const finalSkipped: string[] = [];

        for (const node of nodes) {
            if (node.category === 'FULL_ACCESS') finalFullAccess.push(node.path);
            else if (node.category === 'READ_ONLY') finalReadOnly.push(node.path);
            else if (node.category === 'INACCESSIBLE') finalSkipped.push(node.path);
        }

        const manifest: ValidationManifest = {
            workspaceRoot: targetPath,
            fullAccess: finalFullAccess,
            readOnly: finalReadOnly,
            skipped: Array.from(attemptedPaths).filter(p => !acceptedPaths.has(p)),
            privilegeContext: {
                user: currentUser.name,
                groups: currentUser.groups,
                isRootAvailable,
                switchCommand: shell.activeSwitchCommand
            }
        };

        return manifest;
    }

    private async checkOwnership(shell: PersistentAdbShell, prefix: string, targetPath: string, currentUsername: string): Promise<boolean> {
        const out = await shell.executeCommand(`[ -O "${targetPath}" ] && echo 1 || echo 0`);
        return out.trim() === '1';
    }

    private async traverseAndEvaluate(shell: PersistentAdbShell, prefix: string, targetPath: string, isRootAvailable: boolean): Promise<NodeStatus[]> {
        // Optimized batch script ignoring stderr to prevent 'Permission denied' clutter
        const script = `
        ${prefix} find "${targetPath}" -exec sh -c '
        for f do
            [ -d "$f" ] && d=1 || d=0
            [ -r "$f" ] && r=1 || r=0
            [ -w "$f" ] && w=1 || w=0
            [ -x "$f" ] && x=1 || x=0
            [ -O "$f" ] && o=1 || o=0
            echo "$f|$d|$r|$w|$x|$o"
        done
        ' sh {} + 2>/dev/null
        `;

        const output = await shell.executeCommand(script);
        const lines = output.split('\n').filter(Boolean);
        const nodes: NodeStatus[] = [];

        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length < 6) continue;
            
            const path = parts[0];
            const isDir = parts[1].trim() === '1';
            const isReadable = parts[2].trim() === '1';
            const isWritable = parts[3].trim() === '1';
            const isExecutable = parts[4].trim() === '1';
            const isOwned = parts[5].trim() === '1';

            let category: 'FULL_ACCESS' | 'READ_ONLY' | 'INACCESSIBLE' = 'INACCESSIBLE';

            if (isDir) {
                if (isReadable && isWritable && isExecutable) category = 'FULL_ACCESS';
                else if (isReadable && isExecutable) category = 'READ_ONLY';
            } else {
                if (isReadable && isWritable) category = 'FULL_ACCESS';
                else if (isReadable) category = 'READ_ONLY';
            }

            const isRemediable = isOwned || isRootAvailable;

            nodes.push({
                path,
                isDir,
                isReadable,
                isWritable,
                isExecutable,
                isOwned,
                category,
                isRemediable
            });
        }

        return nodes;
    }

    private buildChmodCommand(node: NodeStatus, recursive: boolean, isRootAvailable: boolean, prefix: string): string {
        // Determine the minimum bits needed
        let targetBits = '';
        if (node.isDir) {
            if (!node.isReadable)  targetBits += 'r';
            if (!node.isWritable)  targetBits += 'w';
            if (!node.isExecutable) targetBits += 'x';
        } else {
            if (!node.isReadable)  targetBits += 'r';
            if (!node.isWritable)  targetBits += 'w';
        }
        if (!targetBits) {
            targetBits = node.isDir ? 'rwx' : 'rw';
        }

        const chmodArgs = recursive ? '-R' : '';

        if (isRootAvailable) {
            // Root: escalate to all-user bits (a+) without checking group membership.
            // Intent: broad dev access. Post-MVP: consider minimum-bits strategy.
            const command = `chmod ${chmodArgs} a+${targetBits} "${node.path}"`;
            return `su -c '${command}'`;
        } else {
            // No root, user is owner: change only owner (u+) bits.
            // Safe default: does not expose file to other system processes.
            return `${prefix} chmod ${chmodArgs} u+${targetBits} "${node.path}"`;
        }
    }

    private removeFromArray(arr: NodeStatus[], item: NodeStatus) {
        const idx = arr.indexOf(item);
        if (idx >= 0) {
            arr.splice(idx, 1);
        }
    }
}
