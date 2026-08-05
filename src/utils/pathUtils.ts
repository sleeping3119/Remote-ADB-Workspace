/**
 * Utility functions for validating file paths against operating system restrictions.
 */

export interface ValidationResult {
    invalid: boolean;
    reason?: string;
}

/**
 * Checks if a path contains components that are invalid on Windows OS file systems.
 * Windows file system rules:
 * 1. Reserved characters: < > : " | ? * and ASCII control characters (0-31)
 * 2. Reserved filenames (case-insensitive):
 *    CON, PRN, AUX, NUL, COM1..COM9, LPT1..LPT9 (e.g. CON, con.txt, AUX.tar.gz)
 * 3. Filename or directory segments ending with a trailing space or dot (e.g. "file.", "dir ")
 */
export function isInvalidWindowsPath(targetPath: string): ValidationResult {
    if (!targetPath) return { invalid: false };

    // Split path into segments (handling both forward and backward slashes)
    // We also ignore '.' and '..' which are valid path navigational components, not literal file names.
    const segments = targetPath.split(/[/\\]+/).filter(s => s && s !== '.' && s !== '..');

    // Reserved filenames regex
    const reservedNameRegex = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

    // Reserved characters regex (excluding / and \ since segments are split, plus ASCII control chars 0-31)
    const reservedCharRegex = /[<>:"|?*\x00-\x1F]/;

    for (const segment of segments) {
        // Check for reserved characters in segment
        if (reservedCharRegex.test(segment)) {
            return {
                invalid: true,
                reason: `contains reserved Windows character(s) (< > : " | ? * or control chars) in "${segment}"`
            };
        }

        // Check for trailing space or dot in segment
        if (/[\s.]$/.test(segment)) {
            return {
                invalid: true,
                reason: `segment ends with a trailing space or dot: "${segment}"`
            };
        }

        // Check for reserved Windows filenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (reservedNameRegex.test(segment)) {
            return {
                invalid: true,
                reason: `uses reserved Windows device name: "${segment}"`
            };
        }
    }

    return { invalid: false };
}
