/**
 * ReplyStream tests — streaming protocol correctness.
 *
 * Verifies: start/chunk/end sequence, abort behavior,
 * AbortSignal, idempotent end/abort, and empty stream handling.
 */

import { describe, it, expect, vi } from 'vitest'
import { ReplyStream } from '../src/domain/reply-stream.js'

function createStream(overrides: Partial<ConstructorParameters<typeof ReplyStream>[0]> = {}) {
  const send = vi.fn()
  const onComplete = vi.fn()
  const stream = new ReplyStream({
    callId: 'CA_test',
    messageId: 'msg_test',
    inReplyTo: 'msg_user_1',
    send,
    onComplete,
    ...overrides,
  })
  return { stream, send, onComplete }
}

describe('ReplyStream', () => {
  // ── Normal flow: write + end ──────────────────────────

  it('first write() sends start then chunk', () => {
    const { stream, send } = createStream()
    stream.write('Hello')

    expect(send).toHaveBeenCalledTimes(2)

    // First call: start
    expect(send.mock.calls[0][0]).toEqual({
      event: 'bot.reply.stream',
      call_id: 'CA_test',
      message_id: 'msg_test',
      action: 'start',
      in_reply_to: 'msg_user_1',
    })

    // Second call: chunk
    expect(send.mock.calls[1][0]).toEqual({
      event: 'bot.reply.stream',
      call_id: 'CA_test',
      message_id: 'msg_test',
      action: 'chunk',
      token: 'Hello',
    })
  })

  it('subsequent writes only send chunks', () => {
    const { stream, send } = createStream()
    stream.write('one')
    stream.write('two')
    stream.write('three')

    // start + 3 chunks = 4 calls
    expect(send).toHaveBeenCalledTimes(4)
    expect(send.mock.calls[2][0].action).toBe('chunk')
    expect(send.mock.calls[3][0].action).toBe('chunk')
  })

  it('end() sends end action', () => {
    const { stream, send } = createStream()
    stream.write('token')
    send.mockClear()

    stream.end()
    expect(send).toHaveBeenCalledWith({
      event: 'bot.reply.stream',
      call_id: 'CA_test',
      message_id: 'msg_test',
      action: 'end',
    })
    expect(stream.ended).toBe(true)
  })

  it('end() on empty stream sends start+end', () => {
    const { stream, send } = createStream()
    stream.end()

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0].action).toBe('start')
    expect(send.mock.calls[1][0].action).toBe('end')
  })

  // ── Abort ─────────────────────────────────────────────

  it('abort() marks as aborted and sends end', () => {
    const { stream, send } = createStream()
    stream.write('token')
    send.mockClear()

    stream.abort()
    expect(stream.aborted).toBe(true)
    expect(stream.ended).toBe(true)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'end' }),
    )
  })

  it('abort() fires AbortSignal', () => {
    const { stream } = createStream()
    const handler = vi.fn()
    stream.signal.addEventListener('abort', handler)

    stream.abort()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('abort() on not-started stream does not send end', () => {
    const { stream, send } = createStream()
    stream.abort()
    // No start was sent, so no end should be sent either
    expect(send).not.toHaveBeenCalled()
  })

  // ── Idempotency ───────────────────────────────────────

  it('write() after end() is no-op', () => {
    const { stream, send } = createStream()
    stream.write('token')
    stream.end()
    send.mockClear()

    stream.write('should be ignored')
    expect(send).not.toHaveBeenCalled()
  })

  it('write() after abort() is no-op', () => {
    const { stream, send } = createStream()
    stream.write('token')
    stream.abort()
    send.mockClear()

    stream.write('should be ignored')
    expect(send).not.toHaveBeenCalled()
  })

  it('double end() is idempotent', () => {
    const { stream, send } = createStream()
    stream.write('token')
    stream.end()
    send.mockClear()

    stream.end()
    expect(send).not.toHaveBeenCalled()
  })

  it('double abort() is idempotent', () => {
    const { stream, send } = createStream()
    stream.write('token')
    stream.abort()
    send.mockClear()

    stream.abort()
    expect(send).not.toHaveBeenCalled()
  })

  // ── onComplete callback ───────────────────────────────

  it('end() fires onComplete once', () => {
    const { stream, onComplete } = createStream()
    stream.end()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('abort() fires onComplete once', () => {
    const { stream, onComplete } = createStream()
    stream.write('token')
    stream.abort()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('onComplete fires only once even with end+abort', () => {
    const { stream, onComplete } = createStream()
    stream.write('token')
    stream.end()
    stream.abort() // should be no-op
    expect(onComplete).toHaveBeenCalledOnce()
  })

  // ── messageId generation ──────────────────────────────

  it('auto-generates messageId when not provided', () => {
    const send = vi.fn()
    const stream = new ReplyStream({
      callId: 'CA_1',
      inReplyTo: 'msg_1',
      send,
    })
    expect(stream.messageId).toMatch(/^msg_/)
  })
})
