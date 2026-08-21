/**
 * A stand-in for the runner's console server — `npm run dev:ui` talks to this.
 *
 * It speaks the frozen contract (/api/agents, /api/calls, /events with a
 * `console.hello` first, /token, /chat-token, /api/calls/:id/hangup) and
 * replays a scripted phone call every 30 seconds, so the console can be built
 * and looked at without a Pinecall account. The real server is the runner's;
 * this one exists for development only and ships in no package (`files: dist`).
 *
 *   node ui/mock/server.mjs [port]     # default 4747
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? process.env.PINECALL_RUN_UI_PORT ?? 4747);
const DIST = fileURLToPath(new URL("../../dist/ui/", import.meta.url));

const AGENTS = [
    {
        id: "clara", label: "Clara · Oximesa", channels: ["phone", "webrtc", "chat"],
        phone: "+34 910 000 000", llm: "openai/gpt-5-chat-latest", voice: "elevenlabs/sarah",
        tools: ["findSlot", "bookSlot"],
    },
];

const clients = new Set();
/** Ended calls, newest first — the live one lives in the script below. */
const history = [];

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };

const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/api/agents") return json(res, 200, { agents: AGENTS });
    if (path === "/api/calls") return json(res, 200, { calls: history.slice(0, 50) });
    if (path === "/token" || path === "/chat-token") {
        return json(res, 200, { token: "mock_token", server: "https://voice.pinecall.io", agent: "clara" });
    }
    if (/^\/api\/calls\/[^/]+\/hangup$/.test(path)) return json(res, 200, { ok: true });

    if (path === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        send(res, "console.hello", { agents: AGENTS, calls: history.slice(0, 50) });
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
    }

    // Static: dist/ui when it is built, with an SPA fallback.
    const rel = normalize(path === "/" ? "index.html" : path.replace(/^\/+/, ""));
    try {
        const body = await readFile(join(DIST, rel));
        res.writeHead(200, { "Content-Type": TYPES[extname(rel)] ?? "application/octet-stream" });
        return res.end(body);
    } catch {
        try {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(await readFile(join(DIST, "index.html")));
        } catch {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("dist/ui is not built — run `npm run build:ui`, or use `npm run dev:ui`.\n");
        }
    }
});

// ── The scripted call ────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scriptedCall(n) {
    const callId = `mock-${n}`;
    const call = { agent: "clara", callId, from: "+34600123456", to: "+34910000000", direction: "inbound", transport: "phone" };
    broadcast("call.ringing", call);
    await wait(800);
    broadcast("call.started", call);
    await wait(700);

    for (const text of ["hola", "hola quería", "hola quería una cita", "hola quería una cita el lunes"]) {
        broadcast("user.speaking", { ...call, text });
        await wait(350);
    }
    broadcast("user.message", { ...call, text: "Hola, quería una cita el lunes." });
    broadcast("turn.end", call);
    await wait(500);

    broadcast("llm.toolCall", { ...call, toolCalls: [{ name: "findSlot", arguments: '{"day":"lunes"}' }] });
    await wait(700);
    broadcast("llm.toolResult", { ...call, name: "findSlot", result: { at: "10:00", doctor: "Ruiz" } });
    await wait(300);

    const reply = "Perfecto, tengo hueco el lunes a las diez con el doctor Ruiz.";
    broadcast("bot.speaking", { ...call, text: reply });
    for (const word of reply.split(" ")) {
        broadcast("bot.word", { ...call, word });
        await wait(180);
    }
    broadcast("bot.finished", call);
    await wait(1200);

    broadcast("user.speaking", { ...call, text: "perfecto" });
    await wait(300);
    broadcast("user.message", { ...call, text: "Perfecto, gracias." });
    await wait(600);
    broadcast("bot.speaking", { ...call, text: "Un placer, hasta el lunes." });
    for (const word of "Un placer, hasta el lunes.".split(" ")) {
        broadcast("bot.word", { ...call, word });
        await wait(160);
    }
    broadcast("bot.interrupted", call);
    await wait(800);

    broadcast("call.ended", { ...call, reason: "hangup", duration: 22 });
    history.unshift({
        id: callId, agent: "clara", channel: "phone", direction: "inbound", peer: call.from,
        startedAt: Date.now() - 22_000, endedAt: Date.now(), durationS: 22, reason: "hangup",
        state: "ended", draft: {},
        lines: [
            { who: "caller", text: "Hola, quería una cita el lunes.", at: Date.now() - 20_000, final: true },
            { who: "agent", text: reply, at: Date.now() - 12_000, final: true },
        ],
    });
}

server.listen(PORT, "127.0.0.1", async () => {
    process.stdout.write(`mock console server → http://127.0.0.1:${PORT}\n`);
    for (let n = 1; ; n++) {
        await scriptedCall(n);
        await wait(8000);
    }
});
