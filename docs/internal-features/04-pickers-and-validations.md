# 6. Folder/File Pickers and Validation

Android's strict SELinux policies and sandboxing require permission verification before mounting remote paths. The extension provides interactive Pickers to navigate the filesystem, followed by an automatic validation and remediation pipeline to ensure the `AdbFileSystemProvider` can access the selected paths.

## Pickers (Folder vs File)

Since VS Code does not have a native remote file picker for raw ADB, the extension implements its own using the QuickPick API.

### Folder Picker (`showFolderPicker`)
- **Usage**: Triggered when opening a new workspace (e.g., via the `Remote ADB: Open Folder` command).
- **Behavior**: Used to select the workspace root directory.
- **Validation**: Triggers the full, rigorous **6-stage validation pipeline** for the entire directory tree.
- **Minimum Criteria**: The selected target folder itself *must* have read and execute (`r-x`) permissions (the "Gatekeeper" check). Without this, the folder cannot be listed or opened.

### File Picker (`showFilePicker`)
- **Usage**: Triggered when selecting individual standalone files.
- **Behavior**: Used to navigate and select a specific file.
- **Validation**: Triggers a simplified **single-file validation**. It checks if the file is readable and writable (`[ -r ] && [ -w ]`). If access is restricted, it prompts the user to attempt a fix (applying the same root/owner `chmod` logic as folder validation), skip, or abort. It bypasses the full 6-stage pipeline.

---

## The Folder Validation Pipeline

Once a user accepts a folder path in the folder picker, the `ValidationManager` takes over and executes a 6-stage pipeline:

### Stage 0: Privilege Discovery
Attempts a dry-run `su -c id` over the persistent shell to determine if the device has `root` available. This dictates how aggressive remediation can be later.

### Stage 1: Gatekeeper Check
Checks if the root target directory has read and execute permissions (`r-x`). If this fails, the workspace cannot be opened at all, and it prompts the user to attempt a fix on the root folder.

### Stage 2: Workspace Traversal
If the root is accessible, it uses an optimized batch script (`find` and `sh`) to recursively scan every file in the target directory in a single ADB round-trip, recording the `rwx` status and ownership (`-O`) of every node.

### Stage 3: System Policy Testing
Categorizes all nodes into `FULL_ACCESS`, `READ_ONLY`, or `INACCESSIBLE`. It also determines if a node is remediable (the user is either `root` or the owner of the file).

### Stage 4: Pre-flight Summary UI
If any files are restricted, it presents a summary UI. This UI shows exactly which files are broken and gives the user choices: Fix All, Skip unfixable items, or Abort opening the workspace.

### Stage 5: Remediation Execution (chmod)
If the user chooses to fix permissions, the action taken depends strictly on available privileges:

- **Root Available (`su`)**: The extension runs `su -c chmod a+<bits> <path>`. This elevates the file to global (all-user) permissions. Since root intent in a developer context implies a desire for broad access, it overrides ownership constraints.
- **No Root, but User is Owner**: The extension runs `chmod u+<bits> <path>`. This modifies *only* the user (owner) bits, which is a safe default that avoids unintentionally exposing the file to other system processes.
- **No Root and Not Owner**: The file cannot be fixed. The user must skip or abort.

> **Recursive Remediation**: When applying fixes to a directory (either individually or via "Fix All"), the UI prompts the user to apply the fix **recursively** (to all nested child items) or to the **folder only**.

### Stage 6: Validation Manifest
Finally, it constructs a `ValidationManifest` (storing the active user, group, switch commands, and file access lists). This manifest is saved to VS Code's global storage. When the window reloads to mount the workspace, the extension reads this manifest to instantly restore the exact execution environment without having to re-validate everything.

> **Diagnostics Tip**: The extension logs the full `ValidationManifest` to the **Remote ADB** Output Terminal when opening a workspace (`[ADB Workspace Validation Manifest]`). Developers can inspect this JSON to debug execution context mismatches (e.g., verifying if it properly detected `run-as com.termux`).

---

## Limitations

- **SELinux Silent Denials**: If a file is blocked by Android's SELinux Context restrictions or Scoped Storage, the remediation stage might execute `chmod` successfully, but a subsequent read check will still fail. The file is marked as permanently unfixable, but the UI currently doesn't explain *why* to the user, which can be confusing if they know they have root.
- **Linear UI Scaling**: The QuickPick-based Pre-flight Summary UI works well for small workspaces but can feel cramped and linear when a massive directory has hundreds of permission errors.

---

## Planned Features

Based on the current implementation, the following features are planned:

1. **Minimum Permissions with `su`**: Instead of granting global access (`a+rwx`) when fixing with root, calculate and apply only the minimum necessary permissions (e.g., just `+r` for read-only files, `+rx` for directories) to prevent over-exposing sensitive system files.
2. **Root SELinux Diagnosis**: If a file is still blocked after a successful root `chmod`, probe the device with `ls -laZ` to determine the SELinux context label and surface a specific denial reason to the user, rather than a generic failure.
3. **Validation UI Polish**: Replace the linear QuickPick summary with a hierarchical TreeView or Webview. This would display columns (Path | Current Perms | Perms After Fix | Action), similar to `ls -la`, making it much easier to digest large numbers of permission issues.
