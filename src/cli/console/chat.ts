/**
 * Text chat from the terminal — what `c` sends.
 *
 * The message goes out on the agent's OWN socket as an `llm.chat` frame. That
 * is the whole trick, and it is why the reply needs no special casing anywhere:
 *
 *   - the server answers `llm.chat.started`, then `chat.message` (the line you
 *     typed) and `chat.response` / `llm.chat.chunk` (what the agent said) on the
 *     socket the agent is already registered on;
 *   - the SDK's ChatHandler turns those into a `Call` with `transport: "chat"`
 *     and the ordinary `chat.started` / `user.message` / `bot.speaking` events;
 *   - so the live view AND the web console AND the developer's own `pc.stream()`
 *     see it exactly as they see a phone call. Three observers, one bus.
 *
 * The alternative — a second WebSocket via `src/api/chat-client.ts` — would
 * need the API key inside the runner and would put the reply on a socket
 * nobody else is watching. One socket, no key, no divergence.
 *
 * ⚠ The session id MUST start with `chat-`: `ToolHandler` routes `llm.tool_call`
 * on that prefix, so a differently-named session silently loses its tools.
 */

/** The slice of Agent this needs — the raw send, nothing more. */
export interface ChatAgentLike {
    id: string;
    _send(data: Record<string, unknown>): void;
}

export function isChatCapable(agent: unknown): agent is ChatAgentLike {
    return typeof (agent as ChatAgentLike | null)?._send === "function";
}

/** A fresh session id. `chat-` prefix is load-bearing — see the note above. */
export function newChatSession(rand: () => number = Math.random): string {
    return `chat-run-${Math.floor(rand() * 0xffffff).toString(36)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * The `llm.chat` frame, built once so the test and the runner agree on it.
 * `metadata.console` is what an agent reads to tell a dev-console turn from a
 * real one — the same marker the web console's tokens carry.
 */
export function chatFrame(agentId: string, sessionId: string, text: string): Record<string, unknown> {
    return {
        event: "llm.chat",
        agent_id: agentId,
        session_id: sessionId,
        text,
        metadata: { console: true },
    };
}

/** Send one line of chat to a live agent. */
export function sendChat(agent: ChatAgentLike, sessionId: string, text: string): void {
    agent._send(chatFrame(agent.id, sessionId, text));
}
