import { describe, it, expect } from "vitest";
import playVoice, {
    parseVoiceString,
    resolveVoice,
    suggest,
    playerCommand,
    extensionFor,
} from "../src/tools/play-voice.js";
import { Session } from "../src/session.js";
import type { Voice } from "../../src/api/voices.js";

const voices: Voice[] = [
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", alias: "sarah", provider: "elevenlabs", languages: [{ code: "en", name: "en" }], previewUrl: "https://example.test/sarah.mp3" },
    { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", alias: "roger", provider: "elevenlabs", languages: [{ code: "en", name: "en" }] },
];

describe("parseVoiceString", () => {
    it("splits provider/alias", () => {
        expect(parseVoiceString("elevenlabs/sarah")).toEqual({ provider: "elevenlabs", alias: "sarah" });
        expect(parseVoiceString(" ElevenLabs/Sarah ")).toEqual({ provider: "elevenlabs", alias: "Sarah" });
    });

    it("refuses a string that is not provider/alias, naming list_voices", () => {
        for (const bad of ["sarah", "", "/sarah", "elevenlabs/"]) {
            expect(() => parseVoiceString(bad)).toThrow(/list_voices/);
        }
    });
});

describe("resolveVoice", () => {
    it("matches the alias case-insensitively, and the raw id too", () => {
        expect(resolveVoice(voices, "SARAH")?.id).toBe("EXAVITQu4vr4xnSDxMaL");
        expect(resolveVoice(voices, "CwhRBWXzGAHq8TQ4Fs17")?.alias).toBe("roger");
    });

    it("returns null for an unknown one", () => {
        expect(resolveVoice(voices, "nobody")).toBeNull();
    });
});

describe("suggest", () => {
    it("puts a near miss first", () => {
        expect(suggest(voices, "sara")[0]).toBe("sarah");
    });
});

describe("playerCommand", () => {
    const none = () => false;
    it("uses afplay on darwin", () => {
        expect(playerCommand("darwin", "/tmp/a.mp3", none)).toEqual({ cmd: "afplay", args: ["/tmp/a.mp3"] });
    });

    it("prefers ffplay on linux, falls back to aplay, else null", () => {
        expect(playerCommand("linux", "/tmp/a.mp3", (b) => b === "ffplay")?.cmd).toBe("ffplay");
        expect(playerCommand("linux", "/tmp/a.mp3", (b) => b === "aplay")?.cmd).toBe("aplay");
        expect(playerCommand("linux", "/tmp/a.mp3", none)).toBeNull();
    });

    it("uses SoundPlayer on win32", () => {
        expect(playerCommand("win32", "C:\\a.wav", none)?.cmd).toBe("powershell");
    });
});

describe("extensionFor", () => {
    it("follows the content type, defaulting to mp3", () => {
        expect(extensionFor("audio/wav")).toBe(".wav");
        expect(extensionFor("audio/mpeg")).toBe(".mp3");
        expect(extensionFor(null)).toBe(".mp3");
    });
});

describe("play_voice handler", () => {
    const session = new Session({ PINECALL_API_KEY: "pk_test", PINECALL_MCP_NO_PLAYBACK: "1" } as any);

    it("an unknown voice errors, naming list_voices", async () => {
        process.env.PINECALL_MCP_NO_PLAYBACK = "1";
        await expect(
            playVoice.handler({ voice: "elevenlabs/definitely-not-a-voice" }, { session }),
        ).rejects.toThrow(/list_voices/);
    });

    it("registers under a name a caller can find", () => {
        expect(playVoice.name).toBe("play_voice");
        expect(playVoice.manual).toMatch(/list_voices/);
    });
});
