/**
 * Protocol utility tests — pure serialization logic, no WebSocket.
 *
 * Tests buildShortcutPayload (camelCase → snake_case), STT expansion,
 * and passthrough of tools/greeting/llm.
 *
 * NOTE: turnDetection is NOT sent over the wire — the server auto-derives
 * it from the STT provider (deepgram-flux → native, others → smart_turn).
 */

import { describe, it, expect } from 'vitest'
import { buildShortcutPayload } from '../src/protocol/shortcuts.js'

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

  // ── Turn detection (auto-derived, NOT sent) ─────────────

  it('does NOT send turnDetection — auto-derived by server', () => {
    const result = buildShortcutPayload({ turnDetection: 'native' })
    expect(result.turn_detection).toBeUndefined()
    expect(result.turnDetection).toBeUndefined()
  })

  it('ignores turnDetection config object', () => {
    const result = buildShortcutPayload({
      turnDetection: { mode: 'smart_turn', silenceMs: 400 },
    })
    expect(result.turn_detection).toBeUndefined()
  })

  // ── LLM ───────────────────────────────────────────────

  it('passes through LLM config object', () => {
    const llm = { provider: 'openai', model: 'gpt-4.1-mini', enabled: true }
    const result = buildShortcutPayload({ llm })
    expect(result.llm).toEqual(llm)
  })

  // ── Tools ─────────────────────────────────────────────

  it('passes through tools array', () => {
    const tools = [{ type: 'function', function: { name: 'test' } }]
    const result = buildShortcutPayload({ tools } as any)
    expect(result.tools).toEqual(tools)
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
      llm: { provider: 'openai', model: 'gpt-4.1', enabled: true },
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    } as any)

    expect(result.voice).toBe('elevenlabs:abc')
    expect(result.language).toBe('es')
    expect(result.stt).toEqual({ provider: 'deepgram', model: 'nova-3', language: 'es' })
    expect(result.turn_detection).toBeUndefined() // auto-derived by server
    expect(result.llm).toEqual({ provider: 'openai', model: 'gpt-4.1', enabled: true })
    expect(result.tools).toHaveLength(1)
  })
})

// ── Wire snapshot ────────────────────────────────────────
//
// The whole point of the encoder: every SDK key lands on the wire under the
// name the server reads, in the order it has always been written, and nothing
// else travels. Locked BEFORE the table-driven rewrite so the refactor cannot
// silently rename, reorder or drop a key.

describe('buildShortcutPayload — wire snapshot', () => {
  const maximal = {
    voice: 'elevenlabs/sarah',
    language: 'es',
    flash: true,
    stt: 'deepgram:nova-3:es',
    interruption: { minWords: 2 },
    llm: 'openai/gpt-4.1-mini',
    prompt: 'You are Clara.',
    promptVars: { name: 'Ana' },
    greeting: 'Hola!',
    greetingInChat: true,
    memory: { remember: ['name'], consolidate: 'turn' },
    timezone: 'Europe/Madrid',
    preparing: { enabled: true, timeoutMs: 2500 },
    rawPrompt: true,
    tools: [{ type: 'function', function: { name: 'lookup' } }],
    skills: [{ name: 'booking' }],
    sessionLimits: { maxDurationMs: 60000 },
    config: { language: 'es' },
    knowledgeBase: ['kb_a', 'kb_b'],
    mode: 'chat',
    media: { video: false },
    // Never travels — auto-derived server-side from the STT provider.
    turnDetection: 'native',
    // Client-side only.
    phoneNumber: '+34600000000',
    allowedOrigins: ['https://x.dev'],
  }

  it('maps every key to its wire name, and nothing else', () => {
    const result = buildShortcutPayload(maximal as any)
    expect(result).toEqual({
      voice: 'elevenlabs/sarah',
      language: 'es',
      flash: true,
      stt: { provider: 'deepgram', model: 'nova-3', language: 'es' },
      interruption: { minWords: 2 },
      llm: 'openai/gpt-4.1-mini',
      prompt: 'You are Clara.',
      vars: { name: 'Ana' },
      greeting: 'Hola!',
      greetingInChat: true,
      memory: { remember: ['name'], consolidate: 'turn' },
      timezone: 'Europe/Madrid',
      preparing: { enabled: true, timeout_ms: 2500 },
      raw_prompt: true,
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      skills: [{ name: 'booking' }],
      session_limits: { maxDurationMs: 60000 },
      config: { language: 'es' },
      knowledge_base: ['kb_a', 'kb_b'],
      mode: 'chat',
      media: { video: false },
    })
  })

  it('writes the keys in the order the server has always received them', () => {
    expect(Object.keys(buildShortcutPayload(maximal as any))).toEqual([
      'voice', 'language', 'flash', 'stt', 'interruption', 'llm', 'prompt',
      'vars', 'greeting', 'greetingInChat', 'memory', 'timezone', 'preparing',
      'raw_prompt', 'tools', 'skills', 'session_limits', 'config',
      'knowledge_base', 'mode', 'media',
    ])
  })

  it('is byte-identical as JSON for the maximal config', () => {
    expect(JSON.stringify(buildShortcutPayload(maximal as any))).toBe(
      '{"voice":"elevenlabs/sarah","language":"es","flash":true,' +
        '"stt":{"provider":"deepgram","model":"nova-3","language":"es"},' +
        '"interruption":{"minWords":2},"llm":"openai/gpt-4.1-mini",' +
        '"prompt":"You are Clara.","vars":{"name":"Ana"},"greeting":"Hola!",' +
        '"greetingInChat":true,"memory":{"remember":["name"],"consolidate":"turn"},' +
        '"timezone":"Europe/Madrid","preparing":{"enabled":true,"timeout_ms":2500},' +
        '"raw_prompt":true,"tools":[{"type":"function","function":{"name":"lookup"}}],' +
        '"skills":[{"name":"booking"}],"session_limits":{"maxDurationMs":60000},' +
        '"config":{"language":"es"},"knowledge_base":["kb_a","kb_b"],' +
        '"mode":"chat","media":{"video":false}}',
    )
  })

  // ── Omission ────────────────────────────────────────────

  it('omits undefined keys instead of sending null', () => {
    const result = buildShortcutPayload({ voice: 'x', language: undefined, prompt: undefined } as any)
    expect(Object.keys(result)).toEqual(['voice'])
    expect(result).not.toHaveProperty('language')
  })

  it('keeps falsy values that are real settings', () => {
    const result = buildShortcutPayload({ flash: false, interruption: false, greetingInChat: false, rawPrompt: false } as any)
    expect(result).toEqual({ flash: false, interruption: false, greetingInChat: false, raw_prompt: false })
  })

  // ── Greeting ────────────────────────────────────────────

  it('sends only the text of a { text, addToHistory } greeting', () => {
    const result = buildShortcutPayload({ greeting: { text: 'Hi!', addToHistory: false } } as any)
    expect(result.greeting).toBe('Hi!')
  })

  it('sends a per-language greeting map whole', () => {
    const greeting = { en: 'Hi!', es: 'Hola!' }
    expect(buildShortcutPayload({ greeting } as any).greeting).toEqual(greeting)
  })

  // ── Preparing ───────────────────────────────────────────

  it('snake-cases preparing.timeoutMs', () => {
    expect(buildShortcutPayload({ preparing: { timeoutMs: 2500 } } as any).preparing)
      .toEqual({ timeout_ms: 2500 })
  })

  it('passes preparing: true / false through untouched', () => {
    expect(buildShortcutPayload({ preparing: true } as any).preparing).toBe(true)
    expect(buildShortcutPayload({ preparing: false } as any).preparing).toBe(false)
  })

  // ── session_limits ──────────────────────────────────────

  it('accepts an already snake_cased session_limits', () => {
    const limits = { maxDurationMs: 10 }
    expect(buildShortcutPayload({ session_limits: limits } as any).session_limits).toEqual(limits)
  })

  it('prefers sessionLimits when both spellings are present', () => {
    const result = buildShortcutPayload({
      sessionLimits: { maxDurationMs: 1 },
      session_limits: { maxDurationMs: 2 },
    } as any)
    expect(result.session_limits).toEqual({ maxDurationMs: 1 })
  })

  // ── tools / skills ──────────────────────────────────────

  it('calls _toWire() on tools and skills that have one', () => {
    const result = buildShortcutPayload({
      tools: [{ _toWire: () => ({ name: 'wired-tool' }) }],
      skills: [{ _toWire: () => ({ name: 'wired-skill' }) }],
    } as any)
    expect(result.tools).toEqual([{ name: 'wired-tool' }])
    expect(result.skills).toEqual([{ name: 'wired-skill' }])
  })
})
