/**
 * list_agents — the org's agents, and which of them are alive right now.
 *
 * Same call the CLI's `pinecall agents` makes: GET {server}/api/sdk/agents.
 * That endpoint is a snapshot of the voice server's IN-MEMORY registry: an
 * agent appears there because a live process is holding a websocket open. So
 * "exists" and "online" are the same fact — there is no server-side directory
 * of configured-but-not-running agents (verified: the playground has no
 * /agents route, and /api/sdk/agent-info 404s for anything not connected).
 *
 * The one place an offline agent CAN be named is the routing tables the same
 * response carries: `phone_map` and `dev_overrides` map a number to a slug. A
 * slug that is claimed there but missing from `agents` is an agent that exists
 * and is NOT running — we reconcile it in as `online: false` rather than
 * dropping it, which is the only honest way this list ever shows an offline
 * agent.
 */

import { defineTool } from "./types.js";

interface RawAgent {
    slug: string;
    phones?: string[];
    channels?: Record<string, { count: number; refs: string[] }>;
    active?: boolean;
    voice?: string | null;
    model?: string | null;
}

interface RawResponse {
    agents?: RawAgent[];
    total?: number;
    phone_map?: Record<string, string> | null;
    dev_overrides?: Record<string, string> | null;
}

export interface AgentEntry {
    slug: string;
    online: boolean;
    /** dev-* slugs are sandboxes — the only ones configure_agent will touch. */
    dev: boolean;
    channels: string[];
    phones?: string[];
    model?: string;
    voice?: string;
}

/** `dev-…` is the sandbox convention the whole MCP keys off. */
export function isDevSlug(slug: string): boolean {
    return slug.startsWith("dev-");
}

/**
 * Pure shaping — kept separate from the fetch so it is testable without a
 * network and so the reconciliation rule above is visible in one place.
 */
export function shapeAgents(data: RawResponse): {
    agents: AgentEntry[];
    total: number;
    online: number;
    offline: number;
    dev: number;
    devOverrides: Record<string, string> | null;
} {
    const raw = data.agents ?? [];
    const seen = new Set<string>();
    const agents: AgentEntry[] = [];

    for (const a of raw) {
        seen.add(a.slug);
        const entry: AgentEntry = {
            slug: a.slug,
            // The endpoint only emits registered agents, but it also carries
            // `active` — trust it rather than hardcoding true.
            online: a.active !== false,
            dev: isDevSlug(a.slug),
            channels: Object.keys(a.channels ?? {}).sort(),
        };
        if (a.phones?.length) entry.phones = a.phones;
        if (a.model) entry.model = a.model;
        if (a.voice) entry.voice = a.voice;
        agents.push(entry);
    }

    // Slugs named by the routing tables but with no live registration.
    for (const slug of [
        ...Object.values(data.phone_map ?? {}),
        ...Object.values(data.dev_overrides ?? {}),
    ]) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        agents.push({ slug, online: false, dev: isDevSlug(slug), channels: [] });
    }

    // Online first, then dev sandboxes, then alphabetical — a stable order the
    // reader can scan.
    agents.sort(
        (x, y) =>
            Number(y.online) - Number(x.online) ||
            Number(x.dev) - Number(y.dev) ||
            x.slug.localeCompare(y.slug),
    );

    const online = agents.filter((a) => a.online).length;
    return {
        agents,
        total: agents.length,
        online,
        offline: agents.length - online,
        dev: agents.filter((a) => a.dev).length,
        devOverrides: data.dev_overrides ?? null,
    };
}

export default defineTool({
    name: "list_agents",
    description:
        "The org's agents with their online state, channels and phone numbers — who exists and who is running right now.",
    schema: {},
    manual: [
        "**`list_agents`** — the org's agents. Returns",
        "`{ agents: [{ slug, online, dev, channels, phones?, model?, voice? }], total, online, offline, dev, devOverrides }`.",
        "",
        "Read it before touching anything:",
        "",
        "- **`dev: true` (a `dev-*` slug) is a sandbox** — those are the ONLY agents you may",
        "  reconfigure. `configure_agent` refuses everything else, by design.",
        "- **`online: true` means a live process owns that agent** — a pm2 service, a `pinecall run`,",
        "  someone's laptop. Reconfiguring an online production agent is a clobber that its owner",
        "  undoes on its next reconnect. Do not try.",
        "- The list is the voice server's live registry, so an agent that no process is running",
        "  simply does not appear. `online: false` entries are agents still claimed by a phone",
        "  route whose process has dropped — a broken number, worth reporting.",
        "- `devOverrides` maps a phone to the dev agent temporarily answering it.",
        "",
        "You can `chat` with any agent here, prod included — that is the testing story.",
    ].join("\n"),
    async handler(_args, { session }) {
        const data = await session.server<RawResponse>("/api/sdk/agents");
        return shapeAgents(data);
    },
});
