/**
 * Protocol utility tests — pure serialization logic, no WebSocket.
 *
 * Tests buildShortcutPayload (camelCase → snake_case), STT expansion,
 * turn detection expansion, and passthrough of tools/greeting/llm.
 */

import { describe, it, expect } from 'vitest'
import { buildShortcutPayload } from '../src/utils/protocol.js'

describe('buildShortcutPayload', () => {
  it('returns empty object for undefined input', () => {
    expect(buildShortcutPayload(undefined)).toEqual({})
  })

  it('returns empty object for empty config', () => {
    expect(buildShortcutPayload({})).toEqual({})
  })

  // ── Voice ──────────────────────────────────────────────

  it('passes through voice string shortcut', () => {
    const result = buildShortcutPayload({ voice: 'elevenlabs:abc' })
    expect(result.voice).toBe('elevenlabs:abc')
  })

  it('passes through voice config object', () => {
    const voice = { engine: 'cartesia', voiceId: 'xyz', speed: 1.2 }
    const result = buildShortcutPayload({ voice })
    expect(result.voice).toEqual(voice)
  })

  // ── Language ───────────────────────────────────────────

  it('passes through language', () => {
    const result = buildShortcutPayload({ language: 'es' })
    expect(result.language).toBe('es')
  })

  // ── STT expansion ─────────────────────────────────────

  it('passes through simple STT string', () => {
    const result = buildShortcutPayload({ stt: 'deepgram' })
    expect(result.stt).toBe('deepgram')
  })

  it('expands STT provider:model shortcut', () => {
    const result = buildShortcutPayload({ stt: 'deepgram:nova-3' })
    expect(result.stt).toEqual({ provider: 'deepgram', model: 'nova-3' })
  })

  it('expands STT provider:model:language shortcut', () => {
    const result = buildShortcutPayload({ stt: 'deepgram:nova-3:fr' })
    expect(result.stt).toEqual({ provider: 'deepgram', model: 'nova-3', language: 'fr' })
  })

  it('passes through STT config object', () => {
    const stt = { engine: 'deepgram', model: 'nova-3' }
    const result = buildShortcutPayload({ stt })
    expect(result.stt).toEqual(stt)
  })

  // ── Turn detection ────────────────────────────────────

  it('passes through turnDetection string as turn_detection', () => {
    const result = buildShortcutPayload({ turnDetection: 'native' })
    expect(result.turn_detection).toBe('native')
    expect(result.turnDetection).toBeUndefined() // camelCase key removed
  })

  it('converts turnDetection silenceMs to snake_case', () => {
    const result = buildShortcutPayload({
      turnDetection: { mode: 'smart_turn', silenceMs: 400 },
    })
    expect(result.turn_detection).toEqual({
      mode: 'smart_turn',
      silence_ms: 400,
    })
  })

  // ── LLM ───────────────────────────────────────────────

  it('passes through LLM config object', () => {
    const llm = { engine: 'openai', model: 'gpt-4.1-mini', enabled: true }
    const result = buildShortcutPayload({ llm })
    expect(result.llm).toEqual(llm)
  })

  // ── Tools ─────────────────────────────────────────────

  it('passes through tools array', () => {
    const tools = [{ type: 'function', function: { name: 'test' } }]
    const result = buildShortcutPayload({ tools } as any)
    expect(result.tools).toEqual(tools)
  })

  // ── Greeting ──────────────────────────────────────────

  it('passes through greeting', () => {
    const result = buildShortcutPayload({ greeting: 'Hello!' } as any)
    expect(result.greeting).toBe('Hello!')
  })

  // ── Interruption ──────────────────────────────────────

  it('passes through interruption: false', () => {
    const result = buildShortcutPayload({ interruption: false })
    expect(result.interruption).toBe(false)
  })

  // ── Combined ──────────────────────────────────────────

  it('handles full agent config', () => {
    const result = buildShortcutPayload({
      voice: 'elevenlabs:abc',
      language: 'es',
      stt: 'deepgram:nova-3:es',
      turnDetection: 'native',
      llm: { engine: 'openai', model: 'gpt-4.1', enabled: true },
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      greeting: 'Hola!',
    } as any)

    expect(result.voice).toBe('elevenlabs:abc')
    expect(result.language).toBe('es')
    expect(result.stt).toEqual({ provider: 'deepgram', model: 'nova-3', language: 'es' })
    expect(result.turn_detection).toBe('native')
    expect(result.llm).toEqual({ engine: 'openai', model: 'gpt-4.1', enabled: true })
    expect(result.tools).toHaveLength(1)
    expect(result.greeting).toBe('Hola!')
  })
})
