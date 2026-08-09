# Remote-ADB-Workspace
A Vs Code extention to provide user iterface that let you do devlopment right in Android  

Main Goal of this project is to provide lightweight VS Code extension that feels like [Wsl Extention](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl) and [Remote SSh](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) by enabling developers to seamlessly browse, edit, and execute code workspaces directly on an Android/Termux device using **solely an ADB (Android Debug Bridge) connection** and **Toybox** in Vscode. 

Unlike standard remote development extensions, it achieves "Remote-SSH" style user experience **without** injecting a heavy, network-bound Node.js server binary into the target environment. This completely bypasses architecture constraints and `glibc` library execution barriers (such as Android’s native reliance on the Bionic C library).
