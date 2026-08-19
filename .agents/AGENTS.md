# Project Blueprint: Remote - ADB Workspace

## 🎯 Goal

The goal of this project is to develop a lightweight VS Code extension that enables developers to seamlessly browse, edit, and execute code workspaces directly on an Android/Termux device using **solely an ADB (Android Debug Bridge) connection**.

Unlike standard remote development extensions, it achieves a full "Remote-SSH" style user experience **without** injecting a heavy, network-bound Node.js server binary into the target environment. This completely bypasses architecture constraints and `glibc` library execution barriers (such as Android’s native reliance on the Bionic C library).

---

## 📝 Extension Description

**Remote - ADB Workspace** is a local-first remote development engine. Instead of operating as a client to a remote daemon, it treats the local computer as the primary compute engine and uses the ADB protocol as a highly optimized abstraction layer for file system mutation and terminal I/O.

To the user, the interface is indistinguishable from standard remote extensions: directories load in the sidebar explorer, files open seamlessly, terminals drop into the device's shell, and code executes with a single click. Under the hood, every single action is intercepted by the extension and translated into raw, low-overhead ADB commands or data pipes over a physical USB or wireless ADB interface.

---

## CORE OPERATING PRINCIPLE:
Before writing or fixing any code, fully understand (1) my request and (2) the existing codebase's logic — don't just pattern-match and start editing.

1. Understand first. Trace how the relevant code actually works end-to-end before touching it.
2. Ask before assuming. If my request is ambiguous, or conflicts with how the code currently works, ask a clarifying question instead of guessing.
3. Suggest better paths. If a simpler, more robust, or lower-risk approach exists than what I described, propose it — explain the tradeoff briefly — before implementing.
4. You can use shell commands in adb connected devices to understand the output and experiment with different approaches.
5. Minimal-diff by default. Implement the requested change with the smallest, most targeted edit that fits naturally into the existing logic and style. Do not refactor or "improve" unrelated code.
6. Deviate only when justified. Only rewrite/restructure existing logic if you're confident it's genuinely broken or incompatible with the new feature, or the feature literally cannot be built otherwise. Never rewrite working code just for the sake of "cleaner" or "more robust" — stability > theoretical elegance.
7. Fit, don't bolt on. New code must match the surrounding logic, naming, and patterns so it reads as if it belongs there.

Your goal isn't just "make it work" — it's to keep the codebase coherent, predictable, and minimally disturbed while delivering exactly what's needed.

---

# Custom Agent Rules

When acting on user queries about ADB or the VS Code Extension API, always consult the local documentation folder first before making assumptions or searching the web.

## Documentation File Location

- All local documentation files are located in: `./dev-docs-for-agent`
  - ADB Documentation: `./dev-docs-for-agent/google-adb-doc.md` , `./dev-docs-for-agent/github-adb-concept.md`
  - VS Code Extension API Documentation: `./dev-docs-for-agent/extension-api`

## Toybox Applets

- All commands running in adb shell should use toybox applets (e.g. `id` -> `toybox id`).
