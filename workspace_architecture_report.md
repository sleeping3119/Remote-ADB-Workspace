# Remote ADB Workspace Architecture Report

This report outlines the precise logic and algorithms used within the Remote ADB Workspace extension to handle file synchronization, cache management, directory listing, and remote file mutations. The extension adopts a local-first philosophy, using a **local cache folder** as the single source of truth for the workspace, minimizing redundant network calls.

---

## 1. Workspace Start and Cache Initialization
When a workspace session starts, `CacheManager.initializeCache()` ([cacheManager.ts:L26-225](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L26-L225)) attempts to establish the single source of truth.

**Algorithm Steps & Code References:**
1. **Cache Folder Creation:** `getCacheDir()` ([cacheManager.ts:L18-24](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L18-L24)) constructs a local cache directory path based on device ID and workspace root. If present, it is cleared via `fs.promises.rm(cacheDir)` ([cacheManager.ts:L41](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L41)).
2. **Pre-calculation:** Executes `toybox find . | toybox wc -l` over shell to count remote files for UI progress calculation ([cacheManager.ts:L57](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L57)).
3. **Remote Link & Streaming:** Spawns `adb exec-out` executing `toybox tar chf - .` ([cacheManager.ts:L64-73](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L64-L73)), linking the remote device natively by streaming compressed tar data to Node.js.
4. **Local Population:** Pipes `stdout` directly into `tar.extract` ([cacheManager.ts:L91-116](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L91-L116)) targeting `cacheDir` to populate the local cache folder.
5. **Validation & Cleanup:** If execution fails (e.g., `FATAL_CD`), the local cache folder is purged ([cacheManager.ts:L173](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L173)) to prevent bad state.

---

## 2. File Opening Logic
Triggered by `AdbFileSystemProvider.readFile()` ([adbFileSystemProvider.ts:L166-218](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L166-L218)), this logic strictly mediates between the remote state and the local cache folder.

**Algorithm Steps & Code References:**
1. **Validation & Cache Invalidation:** Natively evaluates `[ -e ]` and `[ -r ]` ([adbFileSystemProvider.ts:L173](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L173)). If missing/unreadable, it unlinks the local cache entry via `fs.unlinkSync(cachedFilePath)` ([adbFileSystemProvider.ts:L184](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L184)) and throws an error.
2. **Cache Verification:** Checks if the file exists in the cache folder using `fs.existsSync(cachedFilePath)` ([adbFileSystemProvider.ts:L201](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L201)).
3. **On-demand Pull:** If absent, it invokes `CacheManager.pullFileToCache()` ([cacheManager.ts:L249-292](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L249-L292)), executing a targeted `toybox tar chf - "filePath"` stream to extract just that single file into the cache folder.
4. **Delivery:** Serves the cached file data back to VS Code via `fs.promises.readFile(cachedFilePath)` ([adbFileSystemProvider.ts:L207](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L207)).

---

## 3. Folder Listing & Symbolic Link Differentiation
Handled by `AdbFileSystemProvider.readDirectory()` ([adbFileSystemProvider.ts:L95-163](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L95-L163)), querying folder children, mapping file types, and pruning stale cache entries.

**Algorithm Steps & Code References:**
1. **Native Evaluation:** Runs an ADB shell evaluation loop (`ls -1A | while IFS= read -r f; do ...`) ([adbFileSystemProvider.ts:L104](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L104)) evaluating `[ -L ]` (symlink), `[ -d ]` (directory), and `[ -f ]` (file).
2. **Encoding:** Appends `is_sym` flag (`|1` or `|0`) and slash formatting ([adbFileSystemProvider.ts:L104](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L104)).
3. **Local Typing:** Parses the encoded output. If `is_sym === true`, applies bitwise OR `type | vscode.FileType.SymbolicLink` ([adbFileSystemProvider.ts:L138](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L138)) for accurate Explorer icon rendering.
4. **Cache Synchronization (Pruning):** Invokes `CacheManager.syncLocalCache()` ([cacheManager.ts:L227-247](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L227-L247)), comparing actual remote output to local cache folder contents and running `fs.promises.rm(fullPath)` ([cacheManager.ts:L241](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/cacheManager.ts#L241)) on orphan files.

---

## 4. File Saving and Overwriting Logic
Triggered by `AdbFileSystemProvider.writeFile()` ([adbFileSystemProvider.ts:L220-288](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L220-L288)), ensuring symlink-aware remote overwriting while updating the local cache immediately.

**Algorithm Steps & Code References:**
1. **Local Overwrite:** Writes updated bytes directly to local cache folder using `fs.promises.writeFile(cachedFilePath, content)` ([adbFileSystemProvider.ts:L265](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L265)).
2. **Device Link (Temporary Push):** Pushes local cached file via `executeCommandForDevice("push ...")` ([adbFileSystemProvider.ts:L273](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L273)) to a temporary `.raw` file path.
3. **Symlink-Safe Transfer:** Executes `cat "tempFile" > "targetFile"` ([adbFileSystemProvider.ts:L275](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L275)) remotely. Stream redirection `>` forces OS symlink traversal, modifying the underlying target file rather than destroying the link.

---

## 5. File and Folder Creation Logic
Triggered by `writeFile()` with `create: true` ([adbFileSystemProvider.ts:L227-250](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L227-L250)) and `createDirectory()` ([adbFileSystemProvider.ts:L290-318](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L290-L318)).

**Algorithm Steps & Code References:**
1. **Parent Permission Validation:** Asserts write access on parent directory via `[ -w parentPath ]` ([adbFileSystemProvider.ts:L229](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L229), [L297](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L297)).
2. **Remote Creation:** 
   - Files: Executes `touch "targetPath"` ([adbFileSystemProvider.ts:L229](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L229)).
   - Directories: Executes `mkdir -p "targetPath"` ([adbFileSystemProvider.ts:L297](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L297)).
3. **Cache Sync:** Calls `CacheManager.pullFileToCache()` ([adbFileSystemProvider.ts:L246](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L246), [L314](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L314)) to pull and mirror the newly instantiated empty file or directory directly into the local cache folder.
4. **Local Broadcast:** Emits `_onDidChangeFile` (Created) ([adbFileSystemProvider.ts:L249](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L249), [L317](file:///c:/Users/Abdullah/Desktop/projects/Remote-ADB-Workspace/src/fs/adbFileSystemProvider.ts#L317)) to update VS Code UI.
