/**
 * CLI — `pinecall conversations`
 *
 * Browse saved conversation transcripts (chat + voice) for your org.
 * Uses the Playground API: GET /api/conversations and /api/conversations/:id.
 *
 *   pinecall conversations                      List recent conversations
 *   pinecall conversations --type=chat          Filter by type (chat|phone|webrtc)
 *   pinecall conversations --agent=docs         Filter by agent
 *   pinecall conversations --limit=50
 *   pinecall conversations get <id>             Print a full transcript
 */

import type { CliConfig } from "../config.js";
import { c, table, info, error, section, kv } from "../ui.js";

const HELP = `
  ${c.purple("⚡")} ${c.bold("pinecall conversations")} — Saved conversation transcripts

  ${c.bold("Usage:")}
    ${c.dim("$")} pinecall conversations
    ${c.dim("$")} pinecall conversations --type=chat --agent=docs
    ${c.dim("$")} pinecall conversations --limit=50 --json
    ${c.dim("$")} pinecall conversations get <id>

  ${c.bold("See also:")}
    pinecall calls             ${c.dim("Call history with credits/cost")}
`;

async function pg(config: CliConfig, path: string): Promise<any> {
    let res: Response;
    try {
        res = await fetch(`${config.playground}/api${path}`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
    } catch {
        error(`Cannot reach Playground at ${config.playground}`);
    }
    if (!res!.ok) error(`Playground ${res!.status}: ${await res!.text()}`);
    return res!.json();
}

function flag(args: string[], name: string): string | undefined {
    const pre = `--${name}=`;
    const hit = args.find((a) => a.startsWith(pre));
    return hit ? hit.slice(pre.length) : undefined;
}

function when(iso?: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function list(config: CliConfig, args: string[]): Promise<void> {
    const qs = new URLSearchParams();
    qs.set("limit", flag(args, "limit") || "30");
    const type = flag(args, "type");
    const agent = flag(args, "agent");
    if (type) qs.set("type", type);
    if (agent) qs.set("agent", agent);

    const data = await pg(config, `/conversations?${qs.toString()}`);
    const convos = data.conversations ?? [];

    if (config.json) { console.log(JSON.stringify(convos, null, 2)); return; }
    if (!convos.length) { console.log(""); info("No conversations recorded yet."); console.log(""); return; }

    section("Conversations", convos.length);
    table(
        ["ID", "TYPE", "AGENT", "MSGS", "IP", "WHEN"],
        convos.map((c2: any) => [
            c.dim(String(c2.id).slice(0, 10)),
            c2.type || "—",
            c.purple(c2.agentId || "—"),
            String(c2.messageCount ?? 0),
            c.dim(c2.ip || "—"),
            c.dim(when(c2.createdAt)),
        ]),
    );
    info(`View a transcript: ${c.cyan("pinecall conversations get <id>")}`);
}

async function get(config: CliConfig, id: string): Promise<void> {
    if (!id) error("Usage: pinecall conversations get <id>");
    const convo = await pg(config, `/conversations/${id}`);
    if (config.json) { console.log(JSON.stringify(convo, null, 2)); return; }

    section(`Conversation · ${convo.agentId}`, convo.messageCount ?? 0);
    kv("id", convo.id);
    kv("type", convo.type);
    if (convo.ip) kv("ip", `${convo.ip}${convo.ipCountry ? ` (${convo.ipCountry})` : ""}`);
    kv("started", convo.startedAt ? new Date(convo.startedAt).toLocaleString() : "—");
    console.log("");
    for (const m of convo.transcript ?? []) {
        const who = m.role === "user" ? c.cyan("user") : c.purple("agent");
        console.log(`  ${who}${c.dim(":")} ${m.content}`);
    }
    console.log("");
}

export async function conversationsCommand(config: CliConfig, argv: string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
    const positional = argv.filter((a) => !a.startsWith("-") && a !== "conversations" && a !== "chats" && a !== "convos");
    const sub = positional[0];

    switch (sub) {
        case undefined:
        case "list":
            return list(config, argv);
        case "get":
        case "show":
            return get(config, positional[1]);
        default:
            error(`Unknown subcommand: ${sub}\nRun ${c.cyan("pinecall conversations --help")}`);
    }
}
