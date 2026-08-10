import * as vscode from 'vscode';

export class Logger {
    private static channel: vscode.OutputChannel;

    public static initialize(context: vscode.ExtensionContext) {
        this.channel = vscode.window.createOutputChannel('Remote ADB');
        context.subscriptions.push(this.channel);
    }

    public static logCommand(command: string) {
        if (!this.channel) return;
        this.channel.appendLine(`[CMD] ${command}`);
    }

    public static logOutput(output: string) {
        if (!this.channel) return;
        this.channel.appendLine(`[OUT] ${output}`);
    }

    public static logError(error: string) {
        if (!this.channel) return;
        this.channel.appendLine(`[ERR] ${error}`);
        this.channel.show();
    }

    public static logWarning(warning: string) {
        if (!this.channel) return;
        this.channel.appendLine(`[WARN] ${warning}`);
    }

    public static show() {
        if (this.channel) this.channel.show();
    }
}