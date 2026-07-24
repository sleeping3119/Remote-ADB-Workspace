"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const platformToolsManager_1 = require("./src/adb/platformToolsManager");
const toyboxManager_1 = require("./src/adb/toyboxManager");
const logger_1 = require("./src/logger");
async function test() {
    logger_1.Logger.initialize({ subscriptions: [] });
    const context = {
        globalStorageUri: { fsPath: './tmp' }
    };
    const tools = new platformToolsManager_1.PlatformToolsManager(context);
    const toybox = new toyboxManager_1.ToyboxManager(tools, context);
    const { ConnectionManager } = require('./src/adb/connectionManager');
    const conn = new ConnectionManager(tools);
    try {
        const deviceId = '192.168.100.208:5555';
        const prefix = await toybox.getToyboxPrefix(deviceId);
        console.log('Prefix found:', prefix);
        
        const shell = await conn.getPersistentShell(deviceId);
        
        const testScript = `
        ${prefix} find /sdcard/Download -maxdepth 1 -exec sh -c '
        for f do
            [ -d "$f" ] && d=1 || d=0
            [ -r "$f" ] && r=1 || r=0
            [ -w "$f" ] && w=1 || w=0
            [ -x "$f" ] && x=1 || x=0
            [ -O "$f" ] && o=1 || o=0
            echo "$f|$d|$r|$w|$x|$o"
        done
        ' sh {} +
        `;
        
        const output = await shell.executeCommand(testScript);
        console.log('Output:\n', output);
        
        shell.close();
    }
    catch (e) {
        console.error(e);
    }
}
test();
//# sourceMappingURL=test_toybox.js.map