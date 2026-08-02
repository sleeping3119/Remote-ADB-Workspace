/**
 * Escapes a file path or string for safe interpolation within double quotes in POSIX shell commands.
 * Escapes double quotes ("), backslashes (\), dollar signs ($), and backticks (`).
 */
export function escapePath(p: string): string {
    if (!p) return '';
    return p.replace(/["\\$`]/g, '\\$&');
}

/**
 * Escapes a string as a single-quoted argument for POSIX shell commands.
 * Handles embedded single quotes by ending the quote, inserting an escaped single quote, and reopening.
 * E.g., foo'bar => 'foo'\''bar'
 */
export function shellEscape(p: string): string {
    if (!p) return "''";
    return `'${p.replace(/'/g, "'\\''")}'`;
}
