/**
 * Smoke test for this example — the whole flow, against a MOCKED voice server.
 *
 * The server this example needs (`line.create`, `call.route`) ships alongside
 * the SDK, so the example is proved here the way the SDK's own tests prove the
 * line: a real WebSocket server on localhost plays the voice server, and
 * `server.mjs` runs unmodified against it via `PINECALL_URL`.
 *
 * It checks that the example:
 *   1. registers the line (`line.create` with the extension window),
 *   2. routes extension 10 straight to the agent,
 *   3. asks for a language, takes a keypad answer, and speaks the menu,
 *   4. reads opening hours on 1 and hangs up,
 *   5. hands the call over on 0 (`call.route`).
 *
 * Usage:  node smoke.mjs        (from this directory)
 */

import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const NUMBER = "+12186633772";
const AGENT = "smoke-agent";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"}  ${what}`); };

// ── The mocked voice server ──────────────────────────────────────────────

const wss = new WebSocketServer({ port: 0 });
const port = wss.address().port;

/** Every frame the example put on the socket. */
const sent = [];
const waiters = [];

function onFrame(frame) {
    sent.push(frame);
    for (const w of [...waiters]) {
        if (w.match(frame)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(frame);
        }
    }
}

/** Wait for the next frame of a kind (or one already seen since `from`). */
function waitFor(match, label, from = 0) {
    const seen = sent.slice(from).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000);
        waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
}

let socket = null;
const send = (payload) => socket.send(JSON.stringify(payload));

const connected = new Promise((resolve) => {
    wss.on("connection", (ws) => {
        socket = ws;
        ws.on("message", (raw) => {
            let frame;
            try { frame = JSON.parse(raw.toString()); } catch { return; }
            onFrame(frame);
        });
        ws.send(JSON.stringify({ event: "connected", org_id: "org_smoke" }));
        resolve();
    });
});

// ── The example, unmodified ──────────────────────────────────────────────

const child = spawn(process.execPath, ["server.mjs"], {
    cwd: import.meta.dirname,
    env: {
        ...process.env,
        PINECALL_API_KEY: "pk_smoke",
        PINECALL_URL: `ws://127.0.0.1:${port}`,
        LINE_NUMBER: NUMBER,
        AGENT,
        HUMAN: "+15559998888",
    },
    stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", (b) => process.stdout.write(`  [example] ${b}`));

const startCall = (id, extension) => send({
    event: "call.started", agent_id: `line:${NUMBER}`, call_id: id,
    from: "+15551234567", to: NUMBER, direction: "inbound", transport: "phone",
    extension, owner: "line",
});
const press = (id, digit) => send({
    event: "call.dtmf_received", agent_id: `line:${NUMBER}`, call_id: id, digit, digits: digit,
});
/** Let the example hear its own sentence finish, so the next await proceeds. */
async function finishSpeaking(id, from) {
    const reply = await waitFor((f) => f.event === "bot.reply" && f.call_id === id, "bot.reply", from);
    send({ event: "bot.finished", agent_id: `line:${NUMBER}`, call_id: id, message_id: reply.message_id });
    return reply;
}

try {
    await connected;

    // 1. Registration ────────────────────────────────────────────────────
    const create = await waitFor((f) => f.event === "line.create", "line.create");
    check(create.number === NUMBER, `line.create claims ${NUMBER}`);
    check(create.config.extension_window_ms === 2500, "line.create carries the extension window");
    check(create.config.llm === undefined && create.config.prompt === undefined, "no model on the wire");
    check(!sent.some((f) => f.event === "agent.create"), "the example registers NO agent");
    send({ event: "line.created", number: NUMBER });

    // 2. Extension 10 routes straight to the agent ───────────────────────
    startCall("CA_ext", "10");
    const direct = await waitFor((f) => f.event === "call.route" && f.call_id === "CA_ext", "call.route (extension)");
    check(direct.agent === AGENT, `extension 10 routes to ${AGENT} with no menu`);
    check(!sent.some((f) => f.event === "bot.reply" && f.call_id === "CA_ext"), "extension 10 says nothing first");
    send({ event: "call.routed", agent_id: `line:${NUMBER}`, call_id: "CA_ext", agent: AGENT });
    send({ event: "call.ended", agent_id: `line:${NUMBER}`, call_id: "CA_ext", reason: "routed" });

    // 3. No extension → the language question, then the menu ─────────────
    let mark = sent.length;
    startCall("CA_menu", null);
    const question = await finishSpeaking("CA_menu", mark);
    check(/press one or say English/i.test(question.text), "asks for a language on a call with no extension");

    press("CA_menu", "2");                                  // español
    mark = sent.length;
    const menu = await finishSpeaking("CA_menu", mark);
    check(/Marque uno para el horario/.test(menu.text), "the menu is spoken in the language the caller picked");

    // 4. Press 1 → opening hours, then hang up ───────────────────────────
    press("CA_menu", "1");
    mark = sent.length;
    const hours = await finishSpeaking("CA_menu", mark);
    check(/lunes a viernes/.test(hours.text), "option 1 reads the opening hours");
    const hangup = await waitFor((f) => f.event === "call.hangup" && f.call_id === "CA_menu", "call.hangup", mark);
    check(hangup.reason === "done", "and hangs up with a reason the call log keeps");
    send({ event: "call.ended", agent_id: `line:${NUMBER}`, call_id: "CA_menu", reason: "hangup" });

    // 5. Press 0 → the hand-over ─────────────────────────────────────────
    mark = sent.length;
    startCall("CA_route", null);
    await finishSpeaking("CA_route", mark);                 // the language question
    press("CA_route", "1");                                 // English
    mark = sent.length;
    await finishSpeaking("CA_route", mark);                 // the menu
    press("CA_route", "0");
    const route = await waitFor((f) => f.event === "call.route" && f.call_id === "CA_route", "call.route (menu)", mark);
    check(route.agent === AGENT, "option 0 hands the LIVE call to the agent");
    check(route.language === "en" && route.history === true, "the hand-over carries the language and the transcript");
    check(route.context?.came_from === "front_line", "and the context the line learned");
    send({ event: "call.routed", agent_id: `line:${NUMBER}`, call_id: "CA_route", agent: AGENT });
    send({ event: "call.ended", agent_id: `line:${NUMBER}`, call_id: "CA_route", reason: "routed" });

    await new Promise((r) => setTimeout(r, 100));
} catch (err) {
    failures.push(String(err.message ?? err));
    console.error(`FAIL  ${err.message ?? err}`);
} finally {
    child.kill("SIGKILL");
    wss.close();
}

console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
