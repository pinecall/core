/**
 * The server `instructions` — the playbook a coding agent reads before it
 * touches anything.
 *
 * It is ASSEMBLED, never hand-written: the journey preamble below plus each
 * registered tool's own `manual`. One source of truth — a tool cannot exist
 * without documenting itself, and its manual cannot go stale in a second file.
 */

import type { ToolModule } from "./tools/types.js";

export const PLAYBOOK = `# Pinecall MCP — zero to a production voice agent

## The journey

1. \`whoami\` — proves the key, names the org. No key? \`set_api_key\`.
2. Read the docs for what you are building (below). Never guess a shape.
3. Pick from the live catalog, not memory: \`list_models\`, \`list_voices\` (+ \`play_voice\`), \`list_phones\`.
4. \`configure_agent\`, \`dev-\` slug only. Registering HOT-RELOADS the live agent, so a prod
   slug clobbers the process owning it — and its reconnect clobbers you back.
5. Iterate with \`chat\`; it never mutates, so prod is safe to chat.
   **Chat IS the testing story** — no test-runner tool: spec testing is deliberately disabled.
6. Wire a number: a free \`list_phones\` row as \`phoneNumber\`.
7. Debug: \`list_calls\` → \`get_call\`.

Ground with \`knowledge\`, survey with \`list_agents\`, ship via \`pc.agent(...)\`.

## Read before you write

\`docs_search\` locates a page, \`get_doc\` reads it whole. Start from:
first agent → \`quickstart\` + \`guides/build-a-live-call-app\` · phone → \`guides/inbound-voice\`,
\`guides/outbound-calls\` · WhatsApp → \`guides/whatsapp\` · tools → \`guides/tools-and-functions\` ·
browser voice/chat → \`web/widget/overview\`, \`web/chat/overview\` · call log → \`guides/call-log\` ·
multi-tenant → \`guides/multi-tenant\`.

## Not here — say so, do not fake it

- No outbound dialling, no account creation (pinecall.io); \`play_voice\` needs stdio speakers.
- Never print an API key. Page with \`after\`.

## The tools`;

/** Assemble the full instructions string from the playbook + every tool's manual. */
export function buildInstructions(tools: ToolModule<any>[]): string {
    const manuals = tools.map((t) => `### ${t.name}\n\n${t.manual.trim()}`);
    return [PLAYBOOK, ...manuals].join("\n\n");
}
