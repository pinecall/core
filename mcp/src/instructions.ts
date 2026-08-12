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

You are wired into a real Pinecall org. These tools let you build, run and debug a
voice/chat agent without leaving the editor.

## The journey

1. **Authenticate** — \`whoami\`. It names the org you are about to change. No key? \`set_api_key\`.
2. **Read the docs** — \`docs_search\` before you guess an API. The SDK surface is small and specific.
3. **Discover the catalog** — \`list_models\`, \`list_voices\`, \`list_phones\`. Never invent a model id,
   a voice id or a phone number: they are org-specific and a wrong one fails at call time, not at config time.
4. **Configure a DEV agent** — \`configure_agent\` with a slug that starts with \`dev-\`. This is enforced,
   not advisory: registering an agent HOT-RELOADS the live one, so touching a production slug clobbers the
   agent a running process owns, and its next reconnect clobbers you back. Prod agents are deployed from
   code by their own process, never from here.
5. **Iterate by talking to it** — \`chat\`. Chat IS the testing story: send a message, read the reply,
   fix the prompt, send again. There is deliberately no spec-runner tool; a transcript you read yourself
   is the check. \`chat\` works against ANY agent, production included — it only talks, it never mutates.
6. **Debug the real thing** — \`list_calls\` / \`get_call\` for the actual session log of a real call:
   turns, tool invocations, latencies, errors.

## House rules

- **\`dev-\` prefix for anything you create.** It is the whole safety model.
- **Never print an API key.** No tool returns one; do not ask the user to paste one into a file.
- **Results are small JSON on purpose.** Paginate with \`after=\` rather than asking for everything.
- **Verify against reality.** A config that type-checks is not an agent that answers the phone —
  \`chat\` it, then read a real call.

## The tools`;

/** Assemble the full instructions string from the playbook + every tool's manual. */
export function buildInstructions(tools: ToolModule<any>[]): string {
    const manuals = tools.map((t) => `### ${t.name}\n\n${t.manual.trim()}`);
    return [PLAYBOOK, ...manuals].join("\n\n");
}
