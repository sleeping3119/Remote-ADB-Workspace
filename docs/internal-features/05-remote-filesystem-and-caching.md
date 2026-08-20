# 4. Remote File System & Caching

The extension mounts an Android directory as a native VS Code workspace by implementing the `vscode.FileSystemProvider` interface under the `remote-adb://` URI scheme. Every VS Code file operation — browsing, opening, saving, renaming — is translated into shell commands executed over the `PersistentAdbShell` on the connected device.

To make this feel responsive despite ADB latency, the extension maintains a **local disk mirror** of the workspace on the host machine. Files are streamed once via `tar`, cached locally, and validated against the device on every subsequent open.

## Usage & Availability

This feature runs **automatically** once a workspace is opened on an ADB-connected device. There are no commands or UI buttons to interact with the file system provider directly — it powers the standard VS Code Explorer, editor tabs, and file operations.

The background **workspace cache sync** triggers automatically during workspace activation. It shows a notification progress bar ("Caching Remote Workspace — X%") and is **cancellable** by clicking the cancel button on the notification. If cancelled or interrupted, the extension shows a warning with a **"Retry Cache Sync"** button.

Developers should monitor the **Remote ADB** Output panel for diagnostics. The extension logs:

- The local cache mirror path on the host machine (`[CacheManager] Local cache mirror target path: ...`).
- File count estimate and progress during cache sync (`[CacheManager] Initializing cache for ...`).
- Every file skipped during cache sync, with the reason (`Skipped: <path> (Reason: ...)`).
- Warnings when direct file reads fail and fall back to base64 (`[AdbFileSystemProvider] Direct cat via exec-out failed...`).
- The full ADB command executed for every cache pull (`[CacheManager] Executing background cache shell command: ...`).
- The full validation manifest (privilege context, workspace root, switch command) printed on workspace open (`[ADB Workspace Validation Manifest] ...`).
- Per-folder manifest save locations (`[Extension Activate] Saved per-folder manifest to workspace storage: ...`).

---

## Browsing Files (`readDirectory`)

When the VS Code Explorer expands a folder, the extension runs a single shell script inside that directory:

```bash
cd "<path>" || { echo "__CD_FAILED__"; exit; }
ls_out=$(ls -1A 2>&1); ...
# For each entry:
[ -d "$f" ] && [ -r "$f" ] && [ -x "$f" ] && printf "%s/|%s\n" "$f" "$is_sym"
```

This script resolves symlinks, checks read+execute permission on directories and read permission on files, and **filters out inaccessible entries**. Entries that fail these checks are silently excluded from the listing. This is critical — VS Code's recursive search would freeze or crash if it encountered an inaccessible directory.

After each successful listing, the extension also **prunes the local cache**: any cached file or folder that no longer exists on the device is deleted from the local mirror.

> **Getting new files/folders:** The Explorer only re-queries a directory when you expand it or VS Code triggers a refresh. If new files were created on the device, **click the Refresh icon** (↺) at the top of the Explorer sidebar or right-click a folder and select **Refresh** to force the extension to re-read that directory from the device.

---

## Opening Files (`readFile`)

Opening a file follows a layered strategy. If a workspace folder is open, the cache is used; otherwise, the file is read directly from the device.

### With a Workspace Folder (Cache Path)

1. **Remote Metadata Check** — The extension queries the device for the file's existence, read permission, modification time, and size in a single round-trip:

   ```bash
   if [ -e "<path>" ]; then
     if [ -r "<path>" ]; then <toybox> stat -c "OK|%Y|%s" "<path>";
     else echo "NO_READ"; fi;
   else echo "NOT_FOUND"; fi
   ```

   If the file is not found or unreadable, any stale cached copy is deleted.

2. **Cache Validation** — If a cached copy exists locally, the extension compares the remote `mtime` and `size` against the stored **baseline** (a per-file record of `md5`, `mtime`, `size` saved in `.manifest.json`). If they match, the file is served instantly from disk. If they differ, the stale cache is evicted.

3. **Cache Miss → Pull via Tar** — Missing files are pulled from the device by streaming a tar archive over `adb exec-out`:

   ```bash
   cd "<workspaceRoot>" && toybox tar chf - "<relativePath>"
   ```

   Tar is used to mentain the folder structure of pulled file in cache folder.
   The tar stream is piped directly into a Node.js extractor that writes the file into the local cache directory. After extraction, the extension computes an MD5 hash and records the baseline.

4. **Fallback → Direct Remote Read** — If tar extraction fails (e.g., the file's path contains characters illegal on Windows), the extension falls back to reading the file directly via `exec-out cat` → base64 (see below). The file opens correctly but is **not cached**, so every subsequent open re-reads it from the device. To permanently fix this, rename the file on the device to remove the offending characters and reopen it.

### Without a Workspace Folder (Direct Read)

Files opened outside a workspace folder (e.g., via the file picker) skip the cache entirely and are read directly from the device using a two-tier fallback:

1. **`exec-out cat`** — Spawns a separate `adb exec-out cat "<path>"` process. This streams the raw file bytes over stdout, avoiding any text encoding issues. If the user is in a sandbox, the command is automatically wrapped (e.g., `run-as <pkg> sh -c 'cat "<path>"'`).

2. **Base64 over Persistent Shell** — If `exec-out` fails (e.g., due to sandbox restrictions where `exec-out` cannot run under `run-as`), the file is read as a base64-encoded string through the persistent interactive shell: `<toybox> base64 "<path>"`. This is the slowest path but works universally.

### Negative Stat Cache

VS Code's extension host frequently probes for files that almost never exist (`.git/config`, `tsconfig.json`, `package.json`, etc.) during workspace loading. To avoid flooding the device with redundant queries, the extension maintains a **Negative Stat Cache** — an in-memory map with a **10-second TTL**. Any path confirmed as non-existent is cached, and subsequent `stat` calls for the same path within 10 seconds return `FileNotFound` instantly without touching ADB.

---

## Saving Files (`writeFile`)

### Conflict Detection

When saving to a file inside a workspace folder that has a previously recorded baseline, the extension compares the remote file's MD5 hash against the stored baseline hash. If someone (or something) modified the file on the Android device while the developer was editing on the computer, the save is paused and a **modal dialog** appears:

- **"Sync from Android"** — Discards local changes and reloads the file from the device.
- **"Force your changes to Android"** — Overwrites the device's version with the local version.
- **Cancel (dismiss dialog)** — Aborts the save entirely.

### Write Path (Two-Step Push)

Files are saved through a safe two-step process:

1. The content is saved to the local cache file on the host machine.
2. The file is pushed to a temporary location in the device's `.raw` staging area via `adb push`.
3. Inside the persistent shell, the file is moved to its final destination using `cat`:
   ```bash
   cat "/data/local/tmp/.raw/push_<timestamp>" > "<targetPath>"
   ```
   This `cat` approach is essential — it follows symlinks correctly and works inside `run-as` sandboxes where `adb push` cannot write directly.
4. The temporary `.raw` file is deleted.
5. The baseline (`md5`, `mtime`, `size`) is updated.

### Permission Checks
The extension verifies `-w` permission on the parent directory before creating new files. If the folder is read-only, the save is rejected with a clear UI error. (Modifying *existing* files only requires write access to the file itself).

---

## File Management (Create Directory, Delete, Rename)

These operations follow the same pattern:

1. **Permission Check** — Verifies `-w` permission on the parent directory (for rename, checks both source and destination parents). Aborts with a UI error if read-only.
2. **Remote Execution** — Runs the corresponding `toybox` command (`mkdir -p`, `rm -rf`, `mv`) inside the persistent shell.
3. **Local Cache Update** — Mirrors the change in the local cache (creates/removes/moves files and updates the baseline manifest).

All three operations show a clear error message if the parent directory lacks write permission.

---

## Workspace Cache Initialization

When a `remote-adb://` workspace is opened for the first time (or a new folder is added to an existing workspace), the extension runs a **full workspace tar sync** in the background:

1. Estimates total file count via `toybox find . | toybox wc -l` for progress tracking.
2. Streams the entire workspace as a tar archive: `toybox tar chf - .`
3. Extracts directly to the **local cache directory** while reporting progress.
4. Logs all skipped files (permission errors, Windows-invalid paths) to the Output panel and saves them in workspace state.

**Cache folder location:** The cache root is the VS Code workspace storage directory (`context.storageUri`), falling back to global storage if no workspace file is open. The exact path is logged to the Output panel on every sync as `[CacheManager] Local cache mirror target path: <path>`. Inside, each folder is organized as:

```
<cacheRoot>/<sanitized-deviceId>/<sanitized-workspaceRoot>/
    .manifest.json       ← per-file baseline records (md5, mtime, size)
    <mirrored files and folders>
```

This directory is human-readable and can be inspected directly on the host machine.

This only happens **once per workspace session**. The extension records a `cache_initialized` flag in workspace state. On subsequent reloads, the flag is checked and the sync is skipped — the existing local mirror is reused.

If the sync is **cancelled or fails**, the flag is not set, and the extension shows a warning: _"Workspace cache initialization was cancelled. On-demand file loading over ADB will be used, which may take extra time when opening files."_ with a **"Retry Cache Sync"** button. If you skip the retry, every `readFile` call will pull files individually via tar, which works but is noticeably slower for the first open of each file.

**To force a full re-sync at any time**, run the Command Palette command **`Remote ADB: Rebuild Workspace Cache`**. This clears the existing cache directory, resets the `cache_initialized` flag, and re-runs the full tar sync for every open workspace folder.

---

## File Metadata (`stat`)

When VS Code requests metadata for a file, the extension queries directory status, `stat` data, and crucially, **write permission (`-w`)** in a single batched command:

```bash
if [ -w "<path>" ]; then echo "W"; else echo "NW"; fi
if [ -d "<path>" ]; then echo "D"; else echo "ND"; fi
<toybox> stat -c "%f %s %Y" "<path>"
```

Files marked as not writable (`NW`) are strictly treated as **read-only** by VS Code. The editor natively prevents modifications, avoiding a doomed save attempt.

---

## Reconnection Behavior

If the ADB connection drops (cable disconnected, device rebooted), the persistent shell dies and the extension shows an error notification with a **"Reconnect"** button. On reconnect:

- The **local cache is preserved** — no re-download happens.
- A new persistent shell is spawned, and the previous execution context (`run-as`, `su`) is automatically restored.
- Files opened after reconnect are individually validated against the device's current `mtime` and `size`. Stale cached copies are evicted and re-pulled on demand.
- The workspace cache initialization **does not re-run** (the `cache_initialized` flag persists). This means files deleted or added on the device during the disconnection will be discovered incrementally as you browse directories (cache pruning handles deletions; new files appear in directory listings). Use **`Remote ADB: Rebuild Workspace Cache`** if you need to force a fresh full sync after reconnecting.

---

## Limitations

- **No File Watching.** The extension does not detect external changes on the Android device in real-time. If a file is modified on the device (e.g., by a build tool or another app) while the workspace is open, the change will not appear in the editor until you close and reopen the file or until `readFile` re-validates the cached version against the device's metadata. There is no `inotify`-style mechanism over ADB.

- **Windows Path Incompatibility (Partial Handling).** Android filesystems allow characters that Windows does not (`<`, `>`, `:`, `"`, `|`, `?`, `*`), reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), and filenames ending in spaces or dots. The extension handles these in two different ways:
  - **During full workspace cache sync (tar extraction):** Invalid paths are detected, the specific files are **skipped** gracefully with a warning notification and log entry, and the rest of the workspace continues extracting normally. Skipping means those files will not be visible in the local cache and will fall back to direct remote read when opened.
  - **During on-demand single-file pull (tar extraction):** The same tar extractor runs, so Windows-invalid paths trigger a warning. However, since this is a single file pull, if the target file itself has an invalid path, extraction fails and falls back to the `exec-out cat` → base64 direct read path. The file can still be **opened and edited** in VS Code — it just won't be cached locally.
  - **Case-insensitive filename collisions:** Android's filesystem is case-sensitive (`README.md` and `readme.md` can coexist), but the Windows local cache is case-insensitive. If a directory contains files that differ only by case, they will **silently overwrite each other** in the local cache. This is **not detected or handled**. The last-extracted file wins, and the other file's content is lost in the cache (though it remains intact on the device and can be read via the direct fallback).

- **Conflict Detection is Per-File, Not Workspace-Wide.** The MD5-based conflict check only runs when saving an individual file that has a baseline. It does not proactively scan the entire workspace for remote changes. If multiple files were modified on the device, you will only discover conflicts one at a time as you save each file.

- **Cache Directory Layout is Not Content-Addressed.** The local cache mirrors the remote directory structure verbatim (path-mapped, not hash-mapped). This means the cache is human-readable and browsable, but it inherits all the path compatibility issues described above.

- **Multi-Folder Workspaces: Same Device and Same User Required.** You can add multiple Android folders to a single VS Code workspace using `Remote ADB: Open Folder` while a workspace is already open. However, two hard constraints apply:
  - **Same device only.** Adding a folder from a different device is blocked with a "Device Mismatch" error. You will be offered to open it in a new window instead.
  - **Same user environment only.** Adding a folder that requires a different execution context (e.g., the current workspace is `run-as com.termux` but the new folder requires `root`) is blocked with a "User Environment Mismatch" error. Again, you are offered to open it in a new window. This constraint exists because the extension uses a single persistent shell per device, so it can only maintain one active user context at a time.

---

## Planned Features

1. **Real-Time File Watching via Polling.** Implement periodic polling (e.g., `toybox find . -newer <timestamp>` / `toybox inotify`) to detect remote file changes and automatically refresh stale cached files. This would eliminate the need to manually reopen files to pick up external changes.

2. **Workspace-Wide Stale Detection on Reconnect.** After a disconnection and reconnect, run a lightweight diff (comparing remote `mtime`/`size` against all cached baselines) to proactively identify and refresh stale files instead of waiting for the developer to open each one individually.

3. **Ignore Files/Folders from Cache.** Provide a configuration option (e.g., a `.adbignore` file or extension settings) to exclude specific paths from the workspace tar sync. Currently the entire workspace root is streamed, which can be very slow for large workspaces with `node_modules`, build artifacts, or large binary directories. Excluded paths would still be accessible on-demand via the direct read fallback.
