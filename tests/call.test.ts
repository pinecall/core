/**
 * Call tests — isolated call object with mock send().
 *
 * Verifies: say(), reply(), replyStream(), hold/mute, configure,
 * event routing, lastMessageId tracking, and call ending.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Call } from '../src/call.js'

function createCall(overrides: Partial<Parameters<typeof Call.prototype.constructor>[0]> = {}) {
  const send = vi.fn()
  const call = new Call(
    {
      call_id: 'CA_test_123',
      from: '+15551234567',
      to: 'sip:bot@trunk.twilio.com',
      direction: 'inbound',
      transport: 'phone',
      metadata: { channel: 'support' },
      ...overrides,
    } as any,
    send,
  )
  return { call, send }
}

describe('Call', () => {
  // ── Properties ──────────────────────────────────────────

  it('exposes readonly properties', () => {
    const { call } = createCall()
    expect(call.id).toBe('CA_test_123')
    expect(call.from).toBe('+15551234567')
    expect(call.to).toBe('sip:bot@trunk.twilio.com')
    expect(call.direction).toBe('inbound')
    expect(call.transport).toBe('phone')
    expect(call.metadata).toEqual({ channel: 'support' })
  })

  it('defaults transport to unknown', () => {
    const send = vi.fn()
    const call = new Call(
      { call_id: 'CA_1', from: '', to: '', direction: 'inbound' } as any,
      send,
    )
    expect(call.transport).toBe('unknown')
  })

  // ── say() ─────────────────────────────────────────────

  it('say() sends bot.reply with empty in_reply_to', () => {
    const { call, send } = createCall()
    call.say('Hello!')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'bot.reply',
        call_id: 'CA_test_123',
        text: 'Hello!',
        in_reply_to: '',
      }),
    )
    // message_id should be auto-generated
    expect(send.mock.calls[0][0].message_id).toMatch(/^msg_/)
  })

  // ── reply() ───────────────────────────────────────────

  it('reply() uses lastMessageId as in_reply_to', () => {
    const { call, send } = createCall()

    // Simulate user.message to set lastMessageId
    call._handleEvent({ event: 'user.message', message_id: 'msg_user_1', text: 'Hi', turn_id: 1, confidence: 0.99 })

    call.reply('Hello there!')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'bot.reply',
        text: 'Hello there!',
        in_reply_to: 'msg_user_1',
      }),
    )
  })

  it('reply() uses empty string when no lastMessageId', () => {
    const { call, send } = createCall()
    call.reply('No context')
    expect(send.mock.calls[0][0].in_reply_to).toBe('')
  })

  // ── replyStream() ─────────────────────────────────────

  it('replyStream() creates a stream with correct callId', () => {
    const { call } = createCall()
    const stream = call.replyStream()
    expect(stream.callId).toBe('CA_test_123')
    expect(stream.aborted).toBe(false)
    expect(stream.ended).toBe(false)
  })

  it('replyStream() uses turn messageId as in_reply_to', () => {
    const { call, send } = createCall()
    const turn = { id: 1, messageId: 'msg_turn_1', text: 'Hi', confidence: 0.9, probability: 0.95, latencyMs: 200 }
    const stream = call.replyStream(turn)
    stream.write('token')
    // First write triggers start
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'bot.reply.stream',
        action: 'start',
        in_reply_to: 'msg_turn_1',
      }),
    )
  })

  // ── Control methods ───────────────────────────────────

  it('hangup() sends call.hangup', () => {
    const { call, send } = createCall()
    call.hangup()
    expect(send).toHaveBeenCalledWith({ event: 'call.hangup', call_id: 'CA_test_123' })
  })

  it('hold() sends call.hold', () => {
    const { call, send } = createCall()
    call.hold()
    expect(send).toHaveBeenCalledWith({ event: 'call.hold', call_id: 'CA_test_123' })
  })

  it('unhold() sends call.unhold', () => {
    const { call, send } = createCall()
    call.unhold()
    expect(send).toHaveBeenCalledWith({ event: 'call.unhold', call_id: 'CA_test_123' })
  })

  it('mute() sends call.mute', () => {
    const { call, send } = createCall()
    call.mute()
    expect(send).toHaveBeenCalledWith({ event: 'call.mute', call_id: 'CA_test_123' })
  })

  it('sendDTMF() sends digits', () => {
    const { call, send } = createCall()
    call.sendDTMF('1234#')
    expect(send).toHaveBeenCalledWith({ event: 'call.dtmf', call_id: 'CA_test_123', digits: '1234#' })
  })

  it('forward() sends call.forward', () => {
    const { call, send } = createCall()
    call.forward('+15559999999', { message: 'Transferring', announce: true })
    expect(send).toHaveBeenCalledWith({
      event: 'call.forward',
      call_id: 'CA_test_123',
      to: '+15559999999',
      message: 'Transferring',
      announce: true,
    })
  })

  it('configure() sends session.configure', () => {
    const { call, send } = createCall()
    call.configure({ voice: 'cartesia:abc' })
    expect(send).toHaveBeenCalledWith({
      event: 'session.configure',
      session_id: 'CA_test_123',
      voice: 'cartesia:abc',
    })
  })

  // ── Event routing ─────────────────────────────────────

  it('emits user.speaking events', () => {
    const { call } = createCall()
    const handler = vi.fn()
    call.on('user.speaking', handler)
    call._handleEvent({ event: 'user.speaking', text: 'Hello', is_final: false })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].text).toBe('Hello')
  })

  it('emits bot.word events', () => {
    const { call } = createCall()
    const handler = vi.fn()
    call.on('bot.word', handler)
    call._handleEvent({ event: 'bot.word', word: 'Hello', word_index: 0, message_id: 'msg_1' })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].word).toBe('Hello')
  })

  it('emits eager.turn with Turn object', () => {
    const { call } = createCall()
    const handler = vi.fn()
    call.on('eager.turn', handler)
    call._handleEvent({
      event: 'eager.turn',
      turn_id: 1,
      message_id: 'msg_1',
      text: 'Hey',
      probability: 0.9,
      latency_ms: 150,
    })
    expect(handler).toHaveBeenCalledOnce()
    const turn = handler.mock.calls[0][0]
    expect(turn.text).toBe('Hey')
    expect(turn.messageId).toBe('msg_1')
    expect(turn.probability).toBe(0.9)
  })

  it('tracks lastMessageId from user.message', () => {
    const { call } = createCall()
    expect(call.lastMessageId).toBeNull()
    call._handleEvent({ event: 'user.message', message_id: 'msg_u1', text: 'test', turn_id: 1, confidence: 1 })
    expect(call.lastMessageId).toBe('msg_u1')
  })

  it('tracks lastMessageId from eager.turn', () => {
    const { call } = createCall()
    call._handleEvent({ event: 'eager.turn', message_id: 'msg_eager1', text: 'test', turn_id: 1, probability: 0.8, latency_ms: 100 })
    expect(call.lastMessageId).toBe('msg_eager1')
  })

  // ── turn.continued aborts active streams ──────────────

  it('turn.continued aborts active ReplyStreams', () => {
    const { call } = createCall()
    const stream = call.replyStream()
    stream.write('token') // start the stream
    expect(stream.aborted).toBe(false)

    call._handleEvent({ event: 'turn.continued', turn_id: 1 })
    expect(stream.aborted).toBe(true)
  })

  // ── _end() ────────────────────────────────────────────

  it('_end() populates call metadata and emits ended', () => {
    const { call } = createCall()
    const handler = vi.fn()
    call.on('ended', handler)

    call._end('hangup', {
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      duration_seconds: 45,
      started_at: 1700000000,
      ended_at: 1700000045,
    })

    expect(call.reason).toBe('hangup')
    expect(call.duration).toBe(45)
    expect(call.messages).toHaveLength(2)
    expect(call.transcript).toHaveLength(2)
    expect(handler).toHaveBeenCalledWith('hangup')
  })

  it('_end() aborts active streams', () => {
    const { call } = createCall()
    const stream = call.replyStream()
    stream.write('data')
    call._end('timeout')
    expect(stream.aborted).toBe(true)
  })

  // ── transcript getter ─────────────────────────────────

  it('transcript filters to user + assistant only', () => {
    const { call } = createCall()
    call._end('hangup', {
      messages: [
        { role: 'system', content: 'You are...' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'tool', content: '{"result": 1}' },
      ],
    })
    expect(call.transcript).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ])
  })
})
