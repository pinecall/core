/**
 * pinecall test — Voice Client (synthetic caller over WebRTC)
 *
 * Mirrors ChatClient's interface (connect / sendMessage / waitForResponse /
 * close) but drives a REAL voice call:
 *
 *   judge text → ElevenLabs TTS → PCM → RTCAudioSource → WebRTC → server STT
 *   agent reply → bot.word/bot.finished events (data channel) → judge
 *
 * In parallel it opens the live-listen WebSocket (mixed audio of both sides),
 * plays it through the speakers, and records it to a WAV file.
 *
 * Audio is 16-bit PCM, mono, 16kHz throughout (the WebRTC pipeline format).
 */

import WebSocket from "ws";
import type { ToolCallInfo } from "./types.js";
import type { TesterVoice } from "./tts.js";
import { synthesize } from "./tts.js";
import { WavWriter } from "./wav.js";

// @roamhq/wrtc (WebRTC) and speaker (audio out) are native, optional deps —
// loaded dynamically so the text-mode `pinecall test` works without them.
async function loadWrtc(): Promise<any> {
    try {
        const mod: any = await import("@roamhq/wrtc");
        return mod.default ?? mod;
    } catch {
        throw new Error(
            'Voice mode needs "@roamhq/wrtc". Install it: npm i -g @roamhq/wrtc (or add it to your project).',
        );
    }
}

async function loadSpeaker(): Promise<any | null> {
    try {
        const mod: any = await import("speaker");
        return mod.default ?? mod;
    } catch {
        return null; // playback is best-effort
    }
}

const SAMPLE_RATE = 16000;
const FRAME_MS = 10;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160 samples / 10ms
const FRAME_BYTES = FRAME_SAMPLES * 2; // 320 bytes (s16le)
/** Silence after the last bot activity before a turn is considered complete. */
const TURN_QUIET_MS = 1500;

export interface VoiceClientOptions {
    /** HTTPS base, e.g. https://voice.pinecall.io */
    server: string;
    apiKey: string;
    agentId: string;
    /** Tester's spoken voice (ElevenLabs). */
    voice: TesterVoice;
    /** STT provider the session uses to transcribe the tester (e.g. deepgram-flux). */
    stt: string;
    /** Where to write the WAV recording. */
    recordPath: string;
    /** Play the live mixed audio through the speakers. */
    play: boolean;
    /** Optional language override for STT/session. */
    language?: string;
    /** Tester greeting (spoken on connect to open the call). */
    greeting?: string;
    /** Ask the server to emit the agent's turn.end to us. Default true. */
    detectTurnEnd?: boolean;
    log?: (msg: string) => void;
}

interface BotSegment {
    text: string;
    done: boolean;
}

export class VoiceClient {
    private opts: VoiceClientOptions;
    private pc: any = null;
    private source: any = null;
    private dc: any = null;
    private liveWs: WebSocket | null = null;
    private speaker: any = null;
    private SpeakerClass: any = null;
    private wav: WavWriter | null = null;
    private ping: ReturnType<typeof setInterval> | null = null;
    private callId: string | null = null;
    private closed = false;

    // Accumulated agent output since the last waitForResponse() drain.
    private botWords: Record<string, string[]> = {};
    private segments: BotSegment[] = [];
    private pendingTools: ToolCallInfo[] = [];
    private lastBotActivity = 0;
    /** Set when the server emits the agent's turn.end (detectTurnEnd). */
    private peerTurnEnded = false;

    constructor(opts: VoiceClientOptions) {
        this.opts = opts;
    }

    get recordingPath(): string { return this.opts.recordPath; }
    get recordingDuration(): number { return this.wav?.durationSeconds ?? 0; }

    private log(msg: string): void { this.opts.log?.(msg); }

    // ── Connect ──────────────────────────────────────────────

    async connect(): Promise<void> {
        const wrtc = await loadWrtc();
        const RTCPeerConnection = wrtc.RTCPeerConnection;
        const nonstandard = wrtc.nonstandard;
        this.SpeakerClass = this.opts.play ? await loadSpeaker() : null;

        const base = this.opts.server.replace(/\/$/, "");

        // 1. Token (API-key auth → backend-trusted mode).
        const tokRes = await fetch(`${base}/webrtc/token?agent_id=${encodeURIComponent(this.opts.agentId)}`, {
            headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        });
        if (!tokRes.ok) {
            const body = await tokRes.text().catch(() => "");
            throw new Error(`WebRTC token failed (${tokRes.status}): ${body.slice(0, 200)}`);
        }
        const { token, server } = await tokRes.json() as any;
        const voiceServer = (server || base).replace(/\/$/, "");

        // 2. ICE servers (best-effort; fall back to a public STUN).
        let iceServers: any[] = [{ urls: "stun:stun.l.google.com:19302" }];
        try {
            const r = await fetch(`${voiceServer}/webrtc/ice-servers`);
            if (r.ok) {
                const d = await r.json() as any;
                iceServers = d.iceServers || d.ice_servers || iceServers;
            }
        } catch { /* keep STUN fallback */ }

        // 3. Peer connection + outbound audio track (the tester's voice).
        const pc = new RTCPeerConnection({ iceServers });
        this.pc = pc;
        this.source = new nonstandard.RTCAudioSource();
        const track = this.source.createTrack();
        pc.addTrack(track);

        // 4. Events data channel (transcripts, bot speech, tool calls).
        const dc = pc.createDataChannel("events", { ordered: true });
        this.dc = dc;
        dc.onopen = () => {
            this.ping = setInterval(() => {
                if (dc.readyState === "open") dc.send("ping");
            }, 1000);
        };
        dc.onmessage = (msg: any) => this.handleDataChannel(msg.data);

        const connectedPromise = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("WebRTC connect timeout (20s)")), 20000);
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "connected") { clearTimeout(timer); resolve(); }
                else if (pc.connectionState === "failed") { clearTimeout(timer); reject(new Error("WebRTC connection failed")); }
            };
        });

        // 5. Offer → wait for ICE gathering → POST → answer.
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        await this.waitIceComplete(pc);

        const offerRes = await fetch(`${voiceServer}/webrtc/offer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type,
                token,
                config: {
                    stt: { provider: this.opts.stt, ...(this.opts.language ? { language: this.opts.language } : {}) },
                    ...(this.opts.language ? { language: this.opts.language } : {}),
                    // Enable the server-side mixer for live listening + recording.
                    media: { recording: { enabled: true }, live: { enabled: true } },
                    // Ask the server to emit the AGENT's turn.end to us (so the
                    // judge knows when to reply). Default on for voice tests.
                    ...(this.opts.detectTurnEnd !== false ? { detect_turn_end: true } : {}),
                },
            }),
        });
        if (!offerRes.ok) {
            const body = await offerRes.text().catch(() => "");
            throw new Error(`WebRTC offer failed (${offerRes.status}): ${body.slice(0, 200)}`);
        }
        const answer = await offerRes.json() as any;
        this.callId = answer.session_id;
        await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });

        await connectedPromise;

        // 6. Live listen → speaker + WAV.
        this.startLiveListen(voiceServer);
    }

    private waitIceComplete(pc: any): Promise<void> {
        if (pc.iceGatheringState === "complete") return Promise.resolve();
        return new Promise((resolve) => {
            const check = () => {
                if (pc.iceGatheringState === "complete") {
                    pc.removeEventListener?.("icegatheringstatechange", check);
                    resolve();
                }
            };
            pc.addEventListener?.("icegatheringstatechange", check);
            pc.onicecandidate = (e: any) => { if (!e.candidate) resolve(); };
            // Safety: don't wait forever for relay candidates.
            setTimeout(resolve, 3000);
        });
    }

    // ── Live listen (mixed audio) → speakers + WAV ──────────

    private startLiveListen(voiceServer: string): void {
        if (!this.callId) return;
        const wsUrl = voiceServer.replace(/^http/, "ws") + `/live/${this.callId}/ws?token=${encodeURIComponent(this.opts.apiKey)}`;
        const ws = new WebSocket(wsUrl);
        this.liveWs = ws;
        ws.binaryType = "nodebuffer";

        this.wav = new WavWriter(this.opts.recordPath, SAMPLE_RATE, 1);
        if (this.opts.play && this.SpeakerClass) {
            try {
                this.speaker = new this.SpeakerClass({ channels: 1, bitDepth: 16, sampleRate: SAMPLE_RATE });
            } catch (err: any) {
                this.log(`    (speaker unavailable: ${err.message} — recording only)`);
                this.speaker = null;
            }
        } else if (this.opts.play && !this.SpeakerClass) {
            this.log(`    (speaker module not installed — recording only)`);
        }

        ws.on("message", (data: Buffer, isBinary: boolean) => {
            if (!isBinary) return;       // first frame = JSON metadata
            if (data.length < 4) return; // keepalive / silence marker
            this.wav?.write(data);
            try { this.speaker?.write(data); } catch { /* speaker closed */ }
        });
        ws.on("error", () => { /* non-fatal: keep the test running */ });
    }

    // ── Data channel: collect agent output ──────────────────

    private handleDataChannel(raw: any): void {
        let d: any;
        try { d = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }

        switch (d.event) {
            case "bot.speaking":
                if (d.message_id) this.botWords[d.message_id] = [];
                this.lastBotActivity = Date.now();
                break;
            case "bot.word":
                if (d.message_id && d.word) {
                    const arr = this.botWords[d.message_id] ?? (this.botWords[d.message_id] = []);
                    arr[d.word_index ?? arr.length] = d.word;
                    this.lastBotActivity = Date.now();
                }
                break;
            case "bot.finished":
                if (d.message_id) {
                    const text = (d.text || (this.botWords[d.message_id] ?? []).filter(Boolean).join(" ")).trim();
                    this.segments.push({ text, done: true });
                }
                this.lastBotActivity = Date.now();
                break;
            case "llm.tool_call":
                for (const tc of d.tool_calls ?? []) {
                    this.pendingTools.push({
                        name: tc.name,
                        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
                    });
                }
                this.lastBotActivity = Date.now();
                break;
            case "turn.end":
                // The server emits turn.end about the AGENT (source: "bot") only
                // when detect_turn_end is on. Our OWN turn.end has no source — ignore it.
                if (d.source === "bot") this.peerTurnEnded = true;
                break;
        }
    }

    // ── Speak (judge text → TTS → WebRTC) ───────────────────

    async sendMessage(text: string): Promise<void> {
        const pcm = await synthesize(text, this.opts.voice);
        await this.streamPcm(pcm);
    }

    private async streamPcm(pcm: Buffer): Promise<void> {
        for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
            let frame = pcm.subarray(off, off + FRAME_BYTES);
            if (frame.length < FRAME_BYTES) {
                const padded = Buffer.alloc(FRAME_BYTES);
                frame.copy(padded);
                frame = padded;
            }
            const samples = new Int16Array(FRAME_SAMPLES);
            for (let i = 0; i < FRAME_SAMPLES; i++) samples[i] = frame.readInt16LE(i * 2);
            this.source.onData({
                samples,
                sampleRate: SAMPLE_RATE,
                bitsPerSample: 16,
                channelCount: 1,
                numberOfFrames: FRAME_SAMPLES,
            });
            await sleep(FRAME_MS); // pace to real time so the server VAD hears natural speech
        }
    }

    // ── Wait for the agent's turn ───────────────────────────

    waitForResponse(timeoutMs = 30000): Promise<{ text: string; toolCalls: ToolCallInfo[] }> {
        const startedAt = Date.now();
        return new Promise((resolve) => {
            const tick = setInterval(() => {
                const sawTurn = this.segments.length > 0 || this.pendingTools.length > 0;
                // Authoritative: server told us the agent's turn ended (detectTurnEnd).
                const peerDone = this.peerTurnEnded && sawTurn;
                // Fallback when detect_turn_end isn't available: bot.finished + silence.
                const quietDone = sawTurn && (Date.now() - this.lastBotActivity >= TURN_QUIET_MS);
                const timedOut = Date.now() - startedAt >= timeoutMs;
                if (peerDone || quietDone || timedOut) {
                    clearInterval(tick);
                    resolve(this.drain());
                }
            }, 150);
        });
    }

    private drain(): { text: string; toolCalls: ToolCallInfo[] } {
        const text = this.segments.map((s) => s.text).filter(Boolean).join(" ").trim();
        const toolCalls = this.pendingTools.slice();
        this.segments = [];
        this.pendingTools = [];
        this.botWords = {};
        this.peerTurnEnded = false;
        return { text, toolCalls };
    }

    // ── Teardown ─────────────────────────────────────────────

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.ping) { clearInterval(this.ping); this.ping = null; }
        try { this.liveWs?.close(); } catch { /* ignore */ }
        try { this.dc?.close?.(); } catch { /* ignore */ }
        try { this.pc?.close?.(); } catch { /* ignore */ }
        try { this.speaker?.end(); } catch { /* ignore */ }
        this.wav?.close();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
