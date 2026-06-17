/**
 * pinecall test — Streaming WAV writer (voice mode)
 *
 * Writes a canonical 16-bit PCM WAV. We append PCM frames as they arrive from
 * the live-listen WebSocket, then patch the RIFF/data sizes in the header on
 * close — so the file is valid even for long calls without buffering it all in
 * memory.
 */

import * as fs from "node:fs";

export class WavWriter {
    private fd: number;
    private dataBytes = 0;
    private readonly sampleRate: number;
    private readonly channels: number;
    private readonly bitDepth = 16;
    private closed = false;

    constructor(filePath: string, sampleRate = 16000, channels = 1) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.fd = fs.openSync(filePath, "w");
        // Reserve the 44-byte header; sizes are patched in close().
        fs.writeSync(this.fd, Buffer.alloc(44));
    }

    /** Append a chunk of raw PCM (s16le). */
    write(pcm: Buffer): void {
        if (this.closed) return;
        fs.writeSync(this.fd, pcm);
        this.dataBytes += pcm.length;
    }

    /** Patch the header with final sizes and close the file. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        const header = this.buildHeader();
        fs.writeSync(this.fd, header, 0, header.length, 0);
        fs.closeSync(this.fd);
    }

    /** Bytes of audio written so far (excludes header). */
    get bytesWritten(): number {
        return this.dataBytes;
    }

    /** Recorded duration in seconds. */
    get durationSeconds(): number {
        const bytesPerSec = this.sampleRate * this.channels * (this.bitDepth / 8);
        return bytesPerSec ? this.dataBytes / bytesPerSec : 0;
    }

    private buildHeader(): Buffer {
        const h = Buffer.alloc(44);
        const byteRate = this.sampleRate * this.channels * (this.bitDepth / 8);
        const blockAlign = this.channels * (this.bitDepth / 8);

        h.write("RIFF", 0);
        h.writeUInt32LE(36 + this.dataBytes, 4); // RIFF chunk size
        h.write("WAVE", 8);
        h.write("fmt ", 12);
        h.writeUInt32LE(16, 16); // fmt chunk size
        h.writeUInt16LE(1, 20); // PCM
        h.writeUInt16LE(this.channels, 22);
        h.writeUInt32LE(this.sampleRate, 24);
        h.writeUInt32LE(byteRate, 28);
        h.writeUInt16LE(blockAlign, 32);
        h.writeUInt16LE(this.bitDepth, 34);
        h.write("data", 36);
        h.writeUInt32LE(this.dataBytes, 40); // data chunk size
        return h;
    }
}
