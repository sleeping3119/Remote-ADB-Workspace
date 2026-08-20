# 5. Terminal Integration

The Remote ADB Workspace extension integrates with VS Code to automatically provide an interactive ADB shell that matches the workspace's physical path and active execution context (e.g., `root`, `run-as`, `shell`).

## Usage & Availability

- **Auto-Start**: A terminal named **"ADB Shell"** automatically launches and opens when a remote workspace is activated.
- **Manual Launch**: The developer can manually launch new instances at any time by selecting **"ADB Shell"** from the standard VS Code terminal profile dropdown (`+` button).
- **Output Diagnostics**: If the terminal fails to launch automatically during workspace startup, the extension logs `[Extension Activate] Failed to auto-start terminal: <error>` to the Remote ADB output channel.

> **Note on Script Execution**: To keep the extension minimal, there are **no built-in keybindings** (like `F5`) to execute open files automatically. Developers can automate script execution themselves using native VS Code tasks (`tasks.json`) or third-party runner extensions.

## Under the Hood

The extension implements VS Code's `TerminalProfileProvider` API. When a profile is requested, it reads the stored `ValidationManifest` to determine the workspace root and the necessary privilege context.

It builds the `adb shell -t` (pseudo-terminal) arguments dynamically, injecting the correct context and directory switch (`cd`) command.

- **Sandbox / Standard Contexts**:
  For standard users and app sandboxes (e.g., `run-as com.termux`), the `cd` command is passed directly into the shell arguments:
  `shellArgs.push('run-as', pkgName, 'sh', '-c', "cd '<root>' && exec sh")`

- **Root Context (`su`)**:
  Injecting a `cd` command directly into `su` arguments behaves inconsistently across different Android ROMs and `su` binaries. Instead, the extension uses `onDidOpenTerminal` to detect when a root terminal launches and artificially pushes text to the terminal buffer:
  `terminal.sendText("cd '<root>' && clear")`

## Auto-Recovery

If the ADB connection is dropped and later restored, the extension automatically attempts to reopen the terminal workspace. It detects if the original "ADB Shell" terminal died, and if so, quietly spawns a new one using the exact same profile to ensure a seamless developer experience.

## Limitations

- **Hardcoded Shell Executable**: The terminal forces the use of the default `/system/bin/sh`. While it works universally, environments like Termux prefer `bash`, which is currently not dynamically resolved.
- **Root Injection Timing**: Because root directory navigation relies on sending text to the terminal buffer (`sendText`), if the VS Code terminal renders slowly, the `cd` command might visually clutter the initial prompt before the `clear` executes.

## Planned Features

1. **Automatic Termux Environment Hydration**: Automatically source `.bashrc` or `usr/etc/profile` when switching into the Termux context so that `PATH` and environment variables match the exact Termux app experience. (See [User Switching & Execution Contexts](02-user-switching-and-execution-contexts.md#L42)).
2. **Multi-Context Workspaces**: Refactor the underlying shell pool to support multiple independent terminal streams per device, allowing a single VS Code workspace to safely mount both `root` directories and sandboxed app directories simultaneously without terminal context conflicts.
