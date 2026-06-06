/**
 * History — pluggable conversation persistence.
 *
 * The server sends full transcript + LLM messages in the `call.ended` event.
 * When `history` is set on an agent config, conversations are auto-saved
 * on every `call.ended`.
 *
 * Built-in: `JsonFileHistory` — appends to a JSON file on disk.
 * Custom: implement `HistoryStore` (only `save()` is required).
 *
 * @example
 * ```ts
 * import { Pinecall, JsonFileHistory } from "@pinecall/sdk";
 *
 * const history = new JsonFileHistory("./data/calls.json");
 *
 * const agent = pc.agent("my-agent", {
 *     history,  // auto-saves every call
 * });
 *
 * // Load prior conversation for returning callers:
 * agent.on("call.started", async (call) => {
 *     const prior = await history.findByContact(call.from, 1);
 *     if (prior.length > 0) {
 *         await call.setHistory(prior[0].messages);
 *         call.say("Welcome back!");
 *     }
 * });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────

/** A completed conversation record. */
export interface ConversationRecord {
    callId: string;
    agentId: string;
    channel: "phone" | "webrtc" | "chat" | "whatsapp" | "unknown";
    direction: "inbound" | "outbound";
    from: string;
    to: string;
    startedAt: number;
    endedAt: number;
    duration: number;
    reason: string;
    transcript: Array<{ role: string; content: string }>;
    messages: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
}

// ─── Interface ───────────────────────────────────────────────────────────

/**
 * Pluggable storage interface for conversation history.
 *
 * Only `save()` is required. Implement `findByContact`, `list`, `get`,
 * `delete` for richer features (returning callers, admin dashboards, etc.).
 *
 * @example Custom MongoDB store
 * ```ts
 * class MongoHistory implements HistoryStore {
 *     async save(record: ConversationRecord) {
 *         await db.conversations.updateOne(
 *             { callId: record.callId },
 *             { $set: record },
 *             { upsert: true },
 *         );
 *     }
 *
 *     async findByContact(contactId: string, limit = 5) {
 *         return db.conversations
 *             .find({ from: contactId })
 *             .sort({ endedAt: -1 })
 *             .limit(limit)
 *             .toArray();
 *     }
 * }
 * ```
 */
export interface HistoryStore {
    /** Save a completed conversation. Called automatically on call.ended. */
    save(record: ConversationRecord): Promise<void>;

    /**
     * Find conversations by contact identifier (phone number, userId, etc.).
     * Searches the `from` field. Override for custom matching logic.
     */
    findByContact?(contactId: string, limit?: number): Promise<ConversationRecord[]>;

    /** List conversations for an agent, newest first. */
    list?(agentId: string, limit?: number): Promise<ConversationRecord[]>;

    /** Get a single conversation by call ID. */
    get?(callId: string): Promise<ConversationRecord | null>;

    /** Delete a single conversation. Returns true if found and deleted. */
    delete?(callId: string): Promise<boolean>;
}

// ─── JsonFileHistory ─────────────────────────────────────────────────────

/**
 * Built-in history store — appends conversations to a JSON file.
 *
 * Good for prototyping and small projects. For production at scale,
 * implement `HistoryStore` with MongoDB, Postgres, or your own API.
 *
 * @example
 * ```ts
 * import { JsonFileHistory } from "@pinecall/sdk";
 * const history = new JsonFileHistory("./data/calls.json");
 * ```
 */
export class JsonFileHistory implements HistoryStore {
    readonly path: string;

    constructor(path: string) {
        this.path = path;
    }

    async save(record: ConversationRecord): Promise<void> {
        const fs = await import("node:fs/promises");
        const { dirname } = await import("node:path");

        // Ensure directory exists
        try {
            await fs.mkdir(dirname(this.path), { recursive: true });
        } catch { /* already exists */ }

        const data = await this.#readAll();

        // Upsert by callId
        const idx = data.findIndex((r) => r.callId === record.callId);
        if (idx >= 0) {
            data[idx] = record;
        } else {
            data.push(record);
        }

        await fs.writeFile(this.path, JSON.stringify(data, null, 2));
    }

    async findByContact(
        contactId: string,
        limit = 10,
    ): Promise<ConversationRecord[]> {
        const data = await this.#readAll();
        return data
            .filter((r) => r.from === contactId)
            .sort((a, b) => b.endedAt - a.endedAt)
            .slice(0, limit);
    }

    async list(agentId: string, limit = 50): Promise<ConversationRecord[]> {
        const data = await this.#readAll();
        return data
            .filter((r) => r.agentId === agentId)
            .sort((a, b) => b.endedAt - a.endedAt)
            .slice(0, limit);
    }

    async get(callId: string): Promise<ConversationRecord | null> {
        const data = await this.#readAll();
        return data.find((r) => r.callId === callId) ?? null;
    }

    async delete(callId: string): Promise<boolean> {
        const fs = await import("node:fs/promises");
        const data = await this.#readAll();
        const filtered = data.filter((r) => r.callId !== callId);
        if (filtered.length === data.length) return false;
        await fs.writeFile(this.path, JSON.stringify(filtered, null, 2));
        return true;
    }

    // ── Internal ─────────────────────────────────────────────────────────

    async #readAll(): Promise<ConversationRecord[]> {
        const fs = await import("node:fs/promises");
        try {
            const raw = await fs.readFile(this.path, "utf-8");
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
}
