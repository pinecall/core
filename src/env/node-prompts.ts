/**
 * Node prompt file reader — lazy import for browser safety.
 *
 * Fixes the old `require("path")/require("fs")` bundler issue.
 */

export async function readPromptFile(promptsDir: string, filePath: string): Promise<string> {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const resolved = resolve(promptsDir, filePath);
    return readFileSync(resolved, "utf-8").trim();
}
