# 3. Payload Injection (`.raw`) & Toybox

Android's native command-line environment (`toolbox` vs. `toybox`) varies wildly by OEM and often strips crucial flags (like `stat -c`). To guarantee a predictable, standard POSIX environment for the VS Code `FileSystemProvider`, this extension bundles and injects a statically compiled `toybox` binary directly onto the device.

## Usage & Availability
This feature runs **completely automatically** in the background during workspace connection and reconnection. There are no UI buttons or specific commands for developers to invoke it manually. Every file system interaction (like expanding a folder in the explorer) invisibly leverages this injected binary. 

If file parsing breaks or commands fail, developers should check the **Remote ADB** Output Terminal in VS Code. The extension logs the exact ADB commands it attempts (e.g., `adb -s <id> shell <toybox_path> ls -A`) along with their stdout/stderr, which is critical for debugging permission or injection issues.

## Under the Hood Behavior
The lifecycle is handled by `ToyboxManager` (`src/adb/toyboxManager.ts`):

1. **Architecture Detection:** On connection, it queries `getprop ro.product.cpu.abi` to determine the device's CPU architecture (e.g., `arm64-v8a`, `x86_64`).
2. **Bundled Payload:** We currently bundle `toybox` (v0.8.9, sourced from [landley.net/toybox](https://landley.net/toybox/downloads/binaries/0.8.9/)). The specific ABI binaries are shipped inside the extension's `resources/toybox/` directory to ensure offline reliability. 
3. **Global Injection (`shell` / `root`):** It pushes the binary to `/data/local/tmp/.raw/toybox`. This `.raw` directory acts as a globally accessible staging area (created with `mkdir -p` and `chmod 777`), and the binary is marked executable (`chmod 755`).
4. **Sandbox Copying (`run-as`):** Android's application sandboxes block execution of binaries located in `/data/local/tmp`. If connecting to a sandbox (e.g., Termux), the extension uses `cat` to copy the binary from the global `.raw` directory directly into the app's local sandbox (e.g., `~/.raw/toybox`) and secures it with `chmod 700`.
5. **Command Prefixing:** `ToyboxManager` caches the absolute path to this binary in memory. File system operations are then executed by prefixing commands with this path (e.g., `/data/local/tmp/.raw/toybox ls -A /sdcard`), bypassing the device's native `PATH`.

## Limitations
- **Mid-Session Deletion (No Auto-Recovery):** If the `.raw` folder or `toybox` binary is deleted by an external process *while* the extension is actively connected, commands will start failing with "not found" errors. To ensure file system operations remain fast, the extension intentionally does not verify the binary's existence before every single command. We do not automatically clear the cache and re-inject on failure because intercepting and retrying every ADB error would introduce immense complexity and latency. **Fix:** Reconnecting or refreshing the workspace will automatically clear the cache and rebuild the `.raw` environments.
- **SELinux Execution Blocks:** On some strictly locked-down OEM ROMs, SELinux policies may block execution from `/data/local/tmp` entirely. This is a hard OS-level limitation for unrooted environments.

## Planned Features

1. **Manual "Re-inject Utilities" Command:** While we won't implement slow auto-recovery for mid-session deletions, adding a manual VS Code command (e.g., `Remote ADB: Re-inject Utilities`) would allow developers to instantly fix a corrupted `.raw` environment without tearing down and reconnecting the entire workspace session.
