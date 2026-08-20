# 1. Device Connection, Management, and Auto-Connect

The Remote ADB Workspace extension manages connections directly with the Android Debug Bridge (ADB) daemon (`adbd`). It treats the local machine as the primary compute node, completely bypassing the need for a Node.js remote daemon on the target device.

## How to Use This Feature

### GUI, Commands & Active Device Context

You can view and manage connected devices in the **Android Devices** tree view located in the Remote ADB activity bar.

Available commands include:

- `Remote ADB: Connect to USB Device`
- `Remote ADB: Connect via Config` (Connects using your saved configurations)
- `Remote ADB: Connect via TCP/IP`
- `Remote ADB: Pair via TCP/IP`
- `Remote ADB: Switch Active Device`

> **When is `Switch Active Device` needed?**  
> Actions clicked directly from the tree view (such as inline buttons or context menus) automatically target that specific device item. However, when invoking commands globally from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) or shortcuts (e.g., `Remote ADB: Open Folder`, `Remote ADB: Open File`), the extension operates on the currently designated **Active Device**. You can switch the active target using `Remote ADB: Switch Active Device` or by clicking the status bar item (`$(device-mobile) ADB: <id>`).

If a device shows up as `unauthorized` or `offline` in the tree view, clicking on it triggers recovery commands (`remote-adb.handleUnauthorizedDevice` or `remote-adb.handleOfflineDevice`), which guide you through re-authenticating or restarting the ADB server.

### Configuration (`settings.json`)

You can configure custom binary paths and auto-connect targets in your VS Code `settings.json`:

```json
{
  // Path to a custom ADB executable (leave empty to use system PATH or auto-downloaded platform-tools)
  "remote-adb.adbPath": "/path/to/custom/adb",

  // Automatically connect and restore environments on startup
  "remote-adb.savedConnections": [
    {
      "alias": "My Debug App",
      "ipPort": "192.168.1.100:5555",
      "user": "custom",
      "customApp": "com.example.app"
    }
  ]
}
```

- `remote-adb.adbPath`: Custom filesystem path to the `adb` executable. Overrides system PATH and prevents automatic platform-tools downloads.
- `ipPort`: The TCP/IP address and port (e.g., `192.168.1.100:5555`).
- `user`: The target execution user context. Valid options are `"shell"`, `"root"`, `"termux"`, or `"custom"`. For details, see [2. User Switching & Execution Contexts](02-user-switching-and-execution-contexts.md).
- `customApp`: Required if `user` is set to `"custom"`. Specifies the package name of the debuggable app.

## Under the Hood

### Tool Management (`PlatformToolsManager`)

The extension ensures a compatible `adb` binary is available. If a custom path is not specified via the `remote-adb.adbPath` setting, it checks your system `PATH`. If not found, it downloads the official Google Platform-Tools bundle and extracts it into VS Code's global storage directory (e.g., `<globalStorageUri>/platform-tools/adb`).

### Device Lifecycle and Polling (`ConnectionManager`)

- **Polling:** The extension does _not_ blindly poll `adb devices` infinitely in the background. It fetches the device list when you manually refresh the UI tree or perform an action. However, during the auto-connect sequence or offline recovery, it aggressively polls `adb devices` every 1000ms until the device status transitions to `device` (ready) or the 10-second timeout expires.
- **Auto-Connect Execution:** On extension activation, a non-blocking `autoConnectPromise` starts the ADB server, iterates over `savedConnections`, and executes `adb connect <ipPort>`. Once the device is ready, it automatically restores the configured user context. If a VS Code workspace was loaded directly into a `remote-adb://` folder, the filesystem initialization blocks on this promise to ensure the device is mounted first.

### Identifier Resolution (ADB ID vs. Android ID)

An ADB device ID (like `192.168.1.100:5555`) can change between sessions, breaking saved VS Code workspaces. To solve this, the extension runs `adb shell settings get secure android_id` to fetch a static hardware identifier.

- **Workspace URIs** (`remote-adb://<id>`) always use the static **Android ID**.
- **UI and Command Executions** use the volatile **ADB ID** (the IP or serial number).
  The `ConnectionManager` maintains internal maps to seamlessly translate between the two behind the scenes.

### Output Terminal Logging

The extension logs important information to the **Remote ADB** output channel. It logs command execution errors and the raw stdout of shell commands. To prevent log spam, it deliberately suppresses the output of noisy or binary commands such as `adb devices`, `adb push`, and `adb pull`.

## Limitations

- **Dynamic IP Addresses:** Auto-connect via TCP/IP relies on static IP addresses. If the device's IP changes, the `savedConnections` config must be updated manually.
- **Blocking Authorization Prompts:** If a device requires USB debugging authorization, the `adb connect` command will succeed but the device will remain in an `unauthorized` state. The extension cannot bypass this; the user must manually accept the prompt on the device screen.

## Planned Features

1. **mDNS Device Discovery:** Implement local network scanning (mDNS/Bonjour) to automatically discover and list available Wireless Debugging Android devices in the UI, eliminating the need to manually type IP addresses.
2. **Persistent Device Aliasing:** Connecting through users assign friendly names to devices in the UI (e.g., "Pixel 6") that map directly to the `android_id`, making the UI easier to read when multiple devices are connected and easier to connect.
