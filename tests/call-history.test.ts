/**
 * CallHistoryRecorder tests — incremental persistence of a call's conversation.
 *
 * The two behaviours that matter and were previously untested: a burst of
 * messages must coalesce into ONE debounced save, and the end of the call must
 * flush (cancel the pending timer and write the final "ended" record).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Call } from '../src/domain/call.js'
import { CallHistoryRecorder } from '../src/domain/call-history.js'
import type { ConversationRecord, HistoryStore } from '../src/history.js'

function createStore() {
  const saved: ConversationRecord[] = []
  const store: HistoryStore = {
    save: vi.fn(async (record: ConversationRecord) => {
      // Snapshot — the recorder passes the live arrays by reference
      saved.push(JSON.parse(JSON.stringify(record)))
    }),
  }
  return { store, saved }
}

function createCall() {
  const send = vi.fn()
  return new Call(
    {
      call_id: 'CA_hist_1',
      from: '+15551234567',
      to: '+15557654321',
      direction: 'inbound',
      transport: 'phone',
      metadata: { channel: 'support' },
    } as any,
    send,
  )
}

describe('CallHistoryRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves immediately on _initHistory with status active', () => {
    const { store, saved } = createStore()
    const call = createCall()
    call._initHistory('agent-1', store)

    expect(store.save).toHaveBeenCalledTimes(1)
    expect(saved[0].callId).toBe('CA_hist_1')
    expect(saved[0].agentId).toBe('agent-1')
    expect(saved[0].status).toBe('active')
    expect(call.startedAt).toBeGreaterThan(0)
  })

  it('coalesces a burst of messages into one debounced save', () => {
    const { store, saved } = createStore()
    const call = createCall()
    call._initHistory('agent-1', store)
    expect(store.save).toHaveBeenCalledTimes(1) // the initial one

    call._pushMessage({ role: 'user', content: 'hi' })
    call._pushMessage({ role: 'assistant', content: 'hello' })
    call._pushMessage({ role: 'user', content: 'bye' })
    expect(store.save).toHaveBeenCalledTimes(1) // still pending

    vi.advanceTimersByTime(Call.HISTORY_DEBOUNCE_MS)
    expect(store.save).toHaveBeenCalledTimes(2)
    expect(saved[1].messages).toHaveLength(3)
    expect(saved[1].transcript).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ])
  })

  it('debounces again after the timer fired', () => {
    const { store } = createStore()
    const call = createCall()
    call._initHistory('agent-1', store)

    call._pushMessage({ role: 'user', content: 'one' })
    vi.advanceTimersByTime(Call.HISTORY_DEBOUNCE_MS)
    call._pushMessage({ role: 'user', content: 'two' })
    vi.advanceTimersByTime(Call.HISTORY_DEBOUNCE_MS)

    expect(store.save).toHaveBeenCalledTimes(3) // init + two flushes
  })

  it('flushes on call end — the pending save never fires twice', () => {
    const { store, saved } = createStore()
    const call = createCall()
    call._initHistory('agent-1', store)

    call._pushMessage({ role: 'user', content: 'hi' })
    call._applyEnd('hangup', { duration_seconds: 12, started_at: 100, ended_at: 112 })

    expect(store.save).toHaveBeenCalledTimes(2)
    const final = saved[1]
    expect(final.status).toBe('ended')
    expect(final.reason).toBe('hangup')
    expect(final.duration).toBe(12)
    expect(final.endedAt).toBe(112)

    // The debounce timer was cancelled — no third write lands later
    vi.advanceTimersByTime(Call.HISTORY_DEBOUNCE_MS * 10)
    expect(store.save).toHaveBeenCalledTimes(2)
  })

  it('is inert when no store was installed', () => {
    const call = createCall()
    expect(() => {
      call._pushMessage({ role: 'user', content: 'hi' })
      vi.advanceTimersByTime(Call.HISTORY_DEBOUNCE_MS)
      call._applyEnd('hangup')
    }).not.toThrow()
    expect(call.messages).toHaveLength(1)
  })

  it('uses metadata.userId as the contact id when present', () => {
    const { store, saved } = createStore()
    const send = vi.fn()
    const call = new Call(
      {
        call_id: 'CA_hist_2',
        from: '+15551234567',
        to: '+15557654321',
        direction: 'inbound',
        transport: 'chat',
        metadata: { userId: 'user_42' },
      } as any,
      send,
    )
    call._initHistory('agent-1', store)
    expect(saved[0].from).toBe('user_42')
    expect(saved[0].channel).toBe('chat')
  })

  it('Call.HISTORY_DEBOUNCE_MS still reads and writes the recorder constant', () => {
    const original = CallHistoryRecorder.HISTORY_DEBOUNCE_MS
    expect(Call.HISTORY_DEBOUNCE_MS).toBe(original)
    try {
      Call.HISTORY_DEBOUNCE_MS = 50
      expect(CallHistoryRecorder.HISTORY_DEBOUNCE_MS).toBe(50)

      const { store } = createStore()
      const call = createCall()
      call._initHistory('agent-1', store)
      call._pushMessage({ role: 'user', content: 'hi' })
      vi.advanceTimersByTime(50)
      expect(store.save).toHaveBeenCalledTimes(2)
    } finally {
      Call.HISTORY_DEBOUNCE_MS = original
    }
  })
})
