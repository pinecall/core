/**
 * SSE parser — the CLIENT half of Server-Sent Events.
 *
 * `format.ts` writes the wire; this reads it. Incremental by design: feed it
 * whatever the network hands over — a frame may arrive split across chunks,
 * or several frames may land in one — and it dispatches one callback per
 * complete event, as soon as its terminating blank line is in.
 *
 * Handles `data:` (multi-line data joined with "\n", per the spec), `event:`,
 * `id:`, comments (`:ping`) and CRLF/CR line endings. Everything else is
 * ignored.
 */

export interface SSEEvent {
    event?: string;
    id?: string;
    data: string;
}

export interface SSEParser {
    /** Feed raw bytes or text as they arrive. */
    feed(chunk: Uint8Array | string): void;
    /** Flush a trailing event that had no blank line after it. */
    end(): void;
}

export function createSSEParser(onEvent: (evt: SSEEvent) => void): SSEParser {
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let event: string | undefined;
    let id: string | undefined;

    const dispatch = () => {
        if (data.length === 0 && event === undefined && id === undefined) return;
        if (data.length > 0) onEvent({ event, id, data: data.join("\n") });
        data = [];
        event = undefined;
        id = undefined;
    };

    const line = (raw: string) => {
        if (raw === "") { dispatch(); return; }
        if (raw.startsWith(":")) return; // comment / keepalive
        const colon = raw.indexOf(":");
        const field = colon === -1 ? raw : raw.slice(0, colon);
        let value = colon === -1 ? "" : raw.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        switch (field) {
            case "data": data.push(value); break;
            case "event": event = value; break;
            case "id": id = value; break;
            default: break; // retry / unknown fields — not our concern
        }
    };

    const drain = (final: boolean) => {
        // Normalise line endings, then split on what we are sure is complete.
        buffer = buffer.replace(/\r\n?/g, "\n");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            line(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
        }
        if (final && buffer.length > 0) { line(buffer); buffer = ""; }
    };

    return {
        feed(chunk) {
            buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            drain(false);
        },
        end() {
            buffer += decoder.decode();
            drain(true);
            dispatch();
        },
    };
}
