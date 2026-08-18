/**
 * The app's half of the pre-turn barrier.
 *
 * Three things are pinned here, and all three used to be broken:
 *   1. `llm.before` runs the developer's handler and — crucially — WAITS for an
 *      async one before telling the server to go ahead.
 *   2. A history/prompt ack routes even though the server sends it without an
 *      `agent_id`. That single missing field made `await call.setPromptVars()`
 *      hang forever, so an app could not even detect the failure.
 *   3. A request that is never answered rejects instead of hanging, and a
 *      fire-and-forget caller is not taken down by that rejection.
 */

import { describe, it, expect, vi } from 'vitest'
import { Call } from '../src/domain/call.js'
import { PreparingHandler } from '../src/dispatch/handlers/preparing.js'
import { HistoryHandler } from '../src/dispatch/handlers/history.js'
import { buildShortcutPayload, normalizePreparing } from '../src/protocol/shortcuts.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeCall(id = 'chat-1') {
  const send = vi.fn()
  const call = new Call(
    { call_id: id, from: 'chat', to: 'agent', direction: 'inbound', transport: 'chat' } as any,
    send,
  )
  return { call, send }
}

function makeCtx(calls: Record<string, Call>, agentId = 'dev-berna-vars') {
  const sent: Record<string, unknown>[] = []
  const agent = {
    id: agentId,
    _getCall: (id: string) => calls[id],
    _emitWire: vi.fn(),
    _emitPreparing: vi.fn(() => [] as unknown[]),
  }
  const ctx = {
    agent: (id: string) => (id === agentId ? agent : null),
    call: (_a: any, id: string) => calls[id],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    send: (d: Record<string, unknown>) => { sent.push(d) },
    onConnected: vi.fn(),
    emitClientEvent: vi.fn(),
    allAgents: () => [agent],
    whatsappSession: () => undefined,
  } as any
  return { ctx, agent, sent }
}

// ── llm.before → call.preparing → llm.ready ──────────────────────────────

describe('PreparingHandler', () => {
  it('runs call.preparing and answers llm.ready', async () => {
    const { call } = makeCall()
    const { ctx, sent } = makeCtx({ 'chat-1': call })
    const seen: string[] = []
    call.on('call.preparing', () => { seen.push('ran') })

    new PreparingHandler().handle(
      { event: 'llm.before', agent_id: 'dev-berna-vars', call_id: 'chat-1', turn: 7 } as any,
      ctx,
    )
    await tick()

    expect(seen).toEqual(['ran'])
    expect(sent).toEqual([
      { event: 'llm.ready', call_id: 'chat-1', agent_id: 'dev-berna-vars', turn: 7 },
    ])
  })

  it('WAITS for an async handler before releasing the turn', async () => {
    const { call } = makeCall()
    const { ctx, sent } = makeCtx({ 'chat-1': call })
    let resolveHandler: () => void = () => {}
    call.on('call.preparing', () => new Promise<void>((r) => { resolveHandler = r }))

    new PreparingHandler().handle(
      { event: 'llm.before', agent_id: 'dev-berna-vars', call_id: 'chat-1', turn: 1 } as any,
      ctx,
    )
    await tick()
    // Still pending — this is the whole point: releasing here would let the
    // generation start before the app pushed its values.
    expect(sent).toEqual([])

    resolveHandler()
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].event).toBe('llm.ready')
  })

  it('sends the per-turn vars BEFORE llm.ready, so the server sees them first', async () => {
    const { call, send } = makeCall()
    const { ctx, sent } = makeCtx({ 'chat-1': call })
    call.on('call.preparing', async (c) => {
      await Promise.resolve()
      c.setPromptVars({ NONCE: 'abc' })
    })

    new PreparingHandler().handle(
      { event: 'llm.before', agent_id: 'dev-berna-vars', call_id: 'chat-1' } as any,
      ctx,
    )
    await tick()

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'history.set_vars', vars: { NONCE: 'abc' } }),
    )
    expect(sent[0].event).toBe('llm.ready')
  })

  // A handler that throws SYNCHRONOUSLY follows the event bus's global policy
  // (re-thrown via queueMicrotask so it is never swallowed) — that is not this
  // module's contract and is deliberately not re-pinned here. What matters is
  // that a failing handler cannot wedge the turn:
  it('releases the turn even when an async handler rejects', async () => {
    const { call } = makeCall()
    const { ctx, sent } = makeCtx({ 'chat-1': call })
    call.on('call.preparing', async () => { throw new Error('boom') })

    new PreparingHandler().handle(
      { event: 'llm.before', agent_id: 'dev-berna-vars', call_id: 'chat-1' } as any,
      ctx,
    )
    await tick()
    expect(sent[0].event).toBe('llm.ready')
  })

  it('answers immediately when nobody is listening', async () => {
    const { call } = makeCall()
    const { ctx, sent } = makeCtx({ 'chat-1': call })
    new PreparingHandler().handle(
      { event: 'llm.before', agent_id: 'dev-berna-vars', call_id: 'chat-1' } as any,
      ctx,
    )
    await tick()
    expect(sent[0].event).toBe('llm.ready')
  })

  it('surfaces a missed budget as call.preparingTimeout — never silently', async () => {
    const { call } = makeCall()
    const { ctx, agent } = makeCtx({ 'chat-1': call })
    const seen: any[] = []
    call.on('call.preparingTimeout' as any, (e: any) => seen.push(e))

    new PreparingHandler().handle(
      {
        event: 'llm.preparing_timeout',
        agent_id: 'dev-berna-vars',
        call_id: 'chat-1',
        turn: 3,
        waited_ms: 1500,
        budget_ms: 1500,
      } as any,
      ctx,
    )

    expect(seen).toEqual([{ callId: 'chat-1', turn: 3, waitedMs: 1500, budgetMs: 1500 }])
    expect(ctx.logger.warn).toHaveBeenCalled()
    expect(agent._emitWire).toHaveBeenCalledWith(
      'call.preparingTimeout',
      expect.objectContaining({ turn: 3 }),
      call,
    )
  })
})

// ── History acks ─────────────────────────────────────────────────────────

describe('HistoryHandler routing', () => {
  it('routes an ack that carries NO agent_id (the hang that hid all this)', async () => {
    const { call } = makeCall()
    const { ctx } = makeCtx({ 'chat-1': call })
    const pending = call.setPromptVars({ NONCE: 'abc' })

    const handled = new HistoryHandler().handle(
      { event: 'history.updated', call_id: 'chat-1', count: 4 } as any,
      ctx,
    )

    expect(handled).toBe(true)
    await expect(pending).resolves.toBe(4)
  })

  it('correlates concurrent requests by request_id', async () => {
    const { call, send } = makeCall()
    const { ctx } = makeCtx({ 'chat-1': call })
    const first = call.setPromptVars({ A: '1' })
    const second = call.addContext('note')

    const firstId = send.mock.calls[0][0].request_id
    const secondId = send.mock.calls[1][0].request_id
    expect(firstId).not.toBe(secondId)

    // Answered out of order — without request_id the second reply resolved the
    // first caller, because both key on "history.updated".
    new HistoryHandler().handle(
      { event: 'history.updated', call_id: 'chat-1', request_id: secondId, count: 22 } as any,
      ctx,
    )
    new HistoryHandler().handle(
      { event: 'history.updated', call_id: 'chat-1', request_id: firstId, count: 11 } as any,
      ctx,
    )

    await expect(first).resolves.toBe(11)
    await expect(second).resolves.toBe(22)
  })

  it('still routes when the server does name the agent', async () => {
    const { call } = makeCall()
    const { ctx } = makeCtx({ 'chat-1': call })
    const pending = call.getHistory()
    new HistoryHandler().handle(
      {
        event: 'history.data',
        agent_id: 'dev-berna-vars',
        call_id: 'chat-1',
        messages: [{ role: 'user', content: 'hi' }],
      } as any,
      ctx,
    )
    await expect(pending).resolves.toEqual([{ role: 'user', content: 'hi' }])
  })

  it('ignores an ack for a call it does not own', () => {
    const { call } = makeCall()
    const { ctx } = makeCtx({ 'chat-1': call })
    const handled = new HistoryHandler().handle(
      { event: 'history.updated', call_id: 'chat-999', count: 1 } as any,
      ctx,
    )
    expect(handled).toBe(false)
  })
})

// ── Request timeout ──────────────────────────────────────────────────────

describe('Call request timeout', () => {
  it('rejects instead of hanging forever when no ack arrives', async () => {
    vi.useFakeTimers()
    try {
      const { call } = makeCall()
      const pending = call.setPromptVars({ A: '1' })
      const assertion = expect(pending).rejects.toThrow(/Timed out after 10000ms/)
      await vi.advanceTimersByTimeAsync(10_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fire-and-forget call cannot produce an unhandled rejection', async () => {
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { call } = makeCall()
      call.setPromptVars({ A: '1' })       // no await, no catch — the common shape
      await vi.advanceTimersByTimeAsync(10_001)
      vi.useRealTimers()
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      vi.useRealTimers()
    }
  })

  it('clears its timer once the ack lands', async () => {
    vi.useFakeTimers()
    try {
      const { call } = makeCall()
      const { ctx } = makeCtx({ 'chat-1': call })
      const pending = call.setPromptVars({ A: '1' })
      new HistoryHandler().handle(
        { event: 'history.updated', call_id: 'chat-1', count: 3 } as any,
        ctx,
      )
      await expect(pending).resolves.toBe(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── The declaration on the wire ──────────────────────────────────────────

describe('preparing config', () => {
  it('omitting it sends nothing — an old agent keeps the legacy behaviour', () => {
    expect(buildShortcutPayload({ prompt: 'x' } as any).preparing).toBeUndefined()
  })

  it('true and false pass through verbatim', () => {
    expect(buildShortcutPayload({ preparing: true } as any).preparing).toBe(true)
    expect(buildShortcutPayload({ preparing: false } as any).preparing).toBe(false)
  })

  it('timeoutMs becomes snake_case like every other config key', () => {
    expect(buildShortcutPayload({ preparing: { timeoutMs: 2500 } } as any).preparing)
      .toEqual({ timeout_ms: 2500 })
  })

  it('normalizePreparing leaves scalars alone', () => {
    expect(normalizePreparing(true)).toBe(true)
    expect(normalizePreparing(undefined)).toBeUndefined()
    expect(normalizePreparing({ enabled: false })).toEqual({ enabled: false })
  })
})
