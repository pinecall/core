/**
 * The table: which AI coding assistants exist, and where each keeps its MCP config.
 *
 * Pinecall's MCP server is portable — the SAME stdio server works in all six.
 * Only the config file differs (path, format, key), so the differences live
 * here as data and every other module in this folder is format-agnostic.
 */

export const SERVER_NAME = "pinecall";

/** The npm package the host is told to launch. */
export const PACKAGE = "@pinecall/mcp";

export type Format = "json" | "toml";

export interface Platform {
    label: string;
    /** Relative to $HOME. */
    path: string;
    fmt: Format;
    /** The top-level table of MCP servers in that file. */
    key: string;
    /**
     * Relative to $HOME. What proves the product is installed even before it
     * has ever written an MCP config — a fresh Codex has the directory and no
     * file.
     */
    dirHint: string;
}

export const PLATFORMS: Record<string, Platform> = {
    claude: { label: "Claude Code", path: ".claude.json", fmt: "json", key: "mcpServers", dirHint: ".claude" },
    codex: { label: "Codex", path: ".codex/config.toml", fmt: "toml", key: "mcp_servers", dirHint: ".codex" },
    antigravity: {
        label: "Antigravity",
        path: ".gemini/antigravity/mcp_config.json",
        fmt: "json",
        key: "mcpServers",
        dirHint: ".gemini/antigravity",
    },
    cursor: { label: "Cursor", path: ".cursor/mcp.json", fmt: "json", key: "mcpServers", dirHint: ".cursor" },
    windsurf: {
        label: "Windsurf",
        path: ".codeium/windsurf/mcp_config.json",
        fmt: "json",
        key: "mcpServers",
        dirHint: ".codeium/windsurf",
    },
    // NOT ".gemini" — that directory also exists for Antigravity, which nests
    // under it; keying off the settings FILE avoids claiming Gemini CLI is
    // installed when only Antigravity is.
    gemini: {
        label: "Gemini CLI",
        path: ".gemini/settings.json",
        fmt: "json",
        key: "mcpServers",
        dirHint: ".gemini/settings.json",
    },
};

export interface ServerEntry {
    command: string;
    args: string[];
}

/**
 * The server entry.
 *
 * `npx -y @pinecall/mcp` rather than a pinned path: the package resolves to the
 * latest published server on every host, and re-running the install REPLACES
 * this key, so a config that drifted to an old command is repaired rather than
 * duplicated.
 *
 * Deliberately no `env` block — PINECALL_API_KEY is never written into anybody's
 * config file. The server reads it from the environment it is launched in.
 */
export function entry(): ServerEntry {
    return { command: "npx", args: ["-y", PACKAGE] };
}
