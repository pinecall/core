/**
 * Mode — resolve PINECALL_MODE and PINECALL_DEV_ID at import time.
 *
 * Browser-safe: wraps process.env and os.userInfo in try/catch.
 */

function getEnv(key: string): string | undefined {
    try {
        return (globalThis as any).process?.env?.[key];
    } catch {
        return undefined;
    }
}

function getUsername(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("node:os").userInfo().username;
    } catch {
        return "unknown";
    }
}

export const PINECALL_MODE = getEnv("PINECALL_MODE") ?? "";
export const PINECALL_DEV_ID = getEnv("PINECALL_DEV_ID") ?? getUsername();
export const PINECALL_LOG = getEnv("PINECALL_LOG") ?? "";
