# 2. User Switching & Execution Contexts

By default, an ADB shell session drops you into the `shell` user context, which has very limited permissions and cannot access app private data (`/data/data/...`). The Remote ADB Workspace extension provides seamless, persistent user switching (via `su` and `run-as`) so you can work natively inside root or sandboxed app environments.

## How to Use This Feature

### GUI & Extension Commands
You can switch the execution context of the active device using the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):
- `Remote ADB: Switch User to Root` (requires rooted device)
- `Remote ADB: Switch User to Termux` (shortcut for `com.termux`)
- `Remote ADB: Switch User to Custom App` (prompts for package name)
- `Remote ADB: Switch User to Shell` (reverts to default)

### Automatic Workspace Restoration
When you mount a folder into VS Code as a workspace, the extension permanently binds that workspace to the user context you were in at the time. When you reopen that workspace later, the extension reads the stored manifest and automatically re-applies the `su` or `run-as` context before loading the file system. **Mixing different contexts within a single workspace is strictly blocked by the UI to prevent catastrophic file read/write collisions.**

### Terminal Output Logging
The extension logs successful state transitions to the **Remote ADB** output channel, which is useful for debugging workspace initialization. Look for logs like:
- `[Auto-Connect] Switched to <user> on <ipPort>`
- `[Extension Activate] Restoring active user environment: <type>`

## Under the Hood: `PersistentAdbShell`

Switching users in an ADB shell is inherently stateful. Spawning a new `adb shell su -c "..."` process for every file system operation is too slow.

To solve this, the extension uses `PersistentAdbShell`:
1. **Long-Lived Process:** A single `adb -s <id> shell` process is spawned.
2. **State Mutability:** When you trigger a switch, the extension writes `su` or `run-as <pkg>` directly to the `stdin` of this active process.
3. **Delimiter Tracking:** Commands are tracked asynchronously by appending a delimiter (`echo __ADB_EOF__`) and reading `stdout` until the delimiter is hit.

### The `.raw` Directory and Permissions
To guarantee reliable file operations, the extension pushes its own `toybox` binary to the device. The location and permissions of this binary change based on your user context:
- **`shell` or `root` users:** Pushed to `/data/local/tmp/.raw`. The extension runs `mkdir -p` and `chmod 777` on this folder so that it acts as a globally accessible staging area.
- **`run-as` Sandboxes (Custom App / Termux):** Sandboxed apps cannot execute binaries in `/data/local/tmp`. When you switch into a custom app, the extension creates an app-local `.raw` folder inside the app's internal data directory (e.g., `<pwd>/.raw`). It copies the binary using `cat /data/local/tmp/.raw/toybox > <app-dir>/.raw/toybox` and locks it down with `chmod 700` so it can be executed legally by the app UID.

## Limitations
- **`run-as` Restrictions:** The target application must be installed and explicitly marked as `android:debuggable="true"` in its `AndroidManifest.xml`. If it isn't, the switch fails with a "not debuggable" or "unknown package" error.
- **Root Detection:** The extension verifies root by attempting `su` and checking if the prompt's `id` output contains `root`. It will gracefully fail and alert the user if the device is unrooted or if the `su` binary is missing.
- **Auto-Connect Custom App Missing:** If your [`settings.json` configures](01-device-connection-and-management.md#configuration-settingsjson) `"user": "custom"` but you forget to provide the `"customApp"` package name, the extension will throw an explicit UI error and abort the switch.

## Planned Features
1. **Automatic Termux Environment Hydration:** Automatically detect and source `.bashrc` or `usr/etc/profile` or Custom script when switching into the Termux context so that `PATH` and environment variables match the exact Termux app experience. You can check [this repo](https://github.com/sleeping3119/Termux-Over-ADB) if you want it rn.

### Maybe:
2. **Multi-Context Workspaces:** Refactor the `PersistentAdbShell` pool to support multiple independent shell streams per device, allowing a single VS Code workspace to safely mount both `root` directories and sandboxed app directories simultaneously.
