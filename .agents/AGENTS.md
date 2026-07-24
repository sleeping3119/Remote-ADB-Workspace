
# Project Blueprint: Remote - ADB Workspace

## 🎯 Goal
The goal of this project is to develop a lightweight VS Code extension that enables developers to seamlessly browse, edit, and execute code workspaces directly on an Android/Termux device using **solely an ADB (Android Debug Bridge) connection**. 

Unlike standard remote development extensions, it achieves a full "Remote-SSH" style user experience **without** injecting a heavy, network-bound Node.js server binary into the target environment. This completely bypasses architecture constraints and `glibc` library execution barriers (such as Android’s native reliance on the Bionic C library).

---

## 📝 Extension Description
**Remote - ADB Workspace** is a local-first remote development engine. Instead of operating as a client to a remote daemon, it treats the local computer as the primary compute engine and uses the ADB protocol as a highly optimized abstraction layer for file system mutation and terminal I/O. 

To the user, the interface is indistinguishable from standard remote extensions: directories load in the sidebar explorer, files open seamlessly, terminals drop into the device's shell, and code executes with a single click. Under the hood, every single action is intercepted by the extension and translated into raw, low-overhead ADB commands or data pipes over a physical USB or wireless ADB interface.

---

# Custom Agent Rules
When acting on user queries about ADB or the VS Code Extension API, always consult the local documentation folder first before making assumptions or searching the web.
## Documentation File Location
- All local documentation files are located in: `./docs`
  - ADB Documentation: `docs\google-adb-doc.md` , `docs\github-adb-concept.md`
  - VS Code Extension API Documentation: `./docs/extension-api`

## Toybox Applets
- All commands running in adb shell should use toybox applets (e.g. `id` -> `toybox id`).
- You can use shell commands in adb connected devices to understand the output.