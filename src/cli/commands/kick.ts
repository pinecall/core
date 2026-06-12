/**
 * pinecall kick — Force-disconnect an agent from the server.
 *
 * Usage:
 *   pinecall kick <agent>         Force-disconnect agent by slug
 *   pinecall kick <agent> --help  Show help
 */

import type { CliConfig } from "../config.js";
import { c, error, info } from "../ui.js";

export async function kickCommand(config: CliConfig, args: string[]): Promise<void> {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(`
  ${c.purple("⚡")} ${c.bold("pinecall kick")} — Force-disconnect an agent

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall kick <agent>

  Sends a disconnect signal to the agent's WebSocket and
  unregisters it from the server. Use when an agent process
  died without cleanly disconnecting (stale registration).

  ${c.bold("Example:")}
    ${c.dim("$")} pinecall kick pines
`);
        return;
    }

    // Extract agent slug from positional args
    const positional = args.filter((a) => !a.startsWith("--") && a !== "kick");
    const slug = positional[0];

    if (!slug) {
        error("Agent slug required. Usage: pinecall kick <agent>");
    }

    const url = `${config.server}/api/sdk/agents/${encodeURIComponent(slug)}`;
    let res: Response;

    try {
        res = await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
    } catch {
        error(`Cannot reach server at ${config.server}`);
        return;
    }

    if (res!.status === 404) {
        error(`Agent '${slug}' not found — is it connected?`);
        return;
    }

    if (!res!.ok) {
        const text = await res!.text();
        error(`Server returned ${res!.status}: ${text}`);
        return;
    }

    const data = await res!.json();

    if (data.success) {
        info(`${c.purple(data.displaced)} disconnected${data.org_id ? ` ${c.dim(`(${data.org_id})`)}` : ""}`);
    } else {
        error(data.error || "Unknown error");
    }
}
