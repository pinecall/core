/**
 * Agent tests — channel management, event routing, call lifecycle.
 *
 * Uses a mock send function (no WebSocket). Tests the Agent class
 * in isolation from Pinecall client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent } from '../src/agent.js'

function createAgent(id = 'test-agent', config = {}) {
  const send = vi.fn()
  const agent = new Agent(id, config, send)
  return { agent, send }
}

/** Simulate server readiness (normally triggered by Pinecall after agent.created). */
function markReady(agent: Agent) {
  agent._flushPending()
}

describe('Agent', () => {
  // ── Properties ──────────────────────────────────────────

  it('exposes id and name', () => {
    const { agent } = createAgent('my-bot')
    expect(agent.id).toBe('my-bot')
    expect(agent.name).toBe('my-bot')
  })

  it('getConfig() returns initial config', () => {
    const { agent } = createAgent('bot', { voice: 'elevenlabs:abc', language: 'es' })
    expect(agent.getConfig()).toEqual({ voice: 'elevenlabs:abc', language: 'es' })
  })

  // ── Message buffering ─────────────────────────────────

  it('buffers messages before server-ready', () => {
    const { agent, send } = createAgent()
    agent.addChannel('phone', '+15551234567')
    // send should NOT have been called — buffered
    expect(send).not.toHaveBeenCalled()
  })

  it('flushes buffered messages on _flushPending()', () => {
    const { agent, send } = createAgent()
    agent.addChannel('phone', '+15551234567')
    markReady(agent)
    // channel.add should now be sent
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'channel.add', type: 'phone', ref: '+15551234567' }),
    )
  })

  it('sends immediately after server-ready', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    send.mockClear()

    agent.addChannel('phone', '+15559999999')
    expect(send).toHaveBeenCalledOnce()
  })

  // ── Channel management ────────────────────────────────

  it('addChannel() sends channel.add with agent_id', () => {
    const { agent, send } = createAgent('my-bot')
    markReady(agent)
    agent.addChannel('phone', '+15551234567')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'channel.add',
        agent_id: 'my-bot',
        type: 'phone',
        ref: '+15551234567',
      }),
    )
  })

  it('addChannel() validates E.164 phone numbers', () => {
    const { agent } = createAgent()
    markReady(agent)
    expect(() => agent.addChannel('phone', 'abc')).toThrow('Invalid phone number')
  })

  it('addChannel() allows SIP URIs', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    agent.addChannel('phone', 'sip:bot@trunk.twilio.com')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'sip:bot@trunk.twilio.com' }),
    )
  })

  it('addChannel("webrtc") works without ref', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    agent.addChannel('webrtc')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'channel.add', type: 'webrtc' }),
    )
    // No ref key when not provided
    expect(send.mock.calls[0][0].ref).toBeUndefined()
  })

  it('removeChannel() sends channel.remove', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    agent.removeChannel('+15551234567')
    expect(send).toHaveBeenCalledWith({
      event: 'channel.remove',
      agent_id: agent.id,
      ref: '+15551234567',
    })
  })

  // ── configure() ───────────────────────────────────────

  it('configure() sends agent.configure and merges config', () => {
    const { agent, send } = createAgent('bot', { voice: 'elevenlabs:abc' })
    markReady(agent)
    agent.configure({ voice: 'cartesia:xyz', language: 'fr' })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent.configure',
        agent_id: 'bot',
        voice: 'cartesia:xyz',
        language: 'fr',
      }),
    )
    expect(agent.getConfig().voice).toBe('cartesia:xyz')
    expect(agent.getConfig().language).toBe('fr')
  })

  // ── send() (public) ───────────────────────────────────

  it('send() is publicly accessible', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    agent.send({ event: 'llm.tool_result', call_id: 'CA_1', msg_id: 'msg_1', results: [] })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'llm.tool_result' }),
    )
  })

  // ── Call routing ──────────────────────────────────────

  it('call.started creates a Call and emits event', () => {
    const { agent } = createAgent()
    markReady(agent)
    const handler = vi.fn()
    agent.on('call.started', handler)

    agent._handleEvent({
      event: 'call.started',
      call_id: 'CA_001',
      from: '+15551234567',
      to: 'sip:bot@trunk.twilio.com',
      direction: 'inbound',
      transport: 'phone',
    })

    expect(handler).toHaveBeenCalledOnce()
    const call = handler.mock.calls[0][0]
    expect(call.id).toBe('CA_001')
    expect(call.from).toBe('+15551234567')
  })

  it('call.ended removes call and emits event', () => {
    const { agent } = createAgent()
    markReady(agent)
    const startHandler = vi.fn()
    const endHandler = vi.fn()
    agent.on('call.started', startHandler)
    agent.on('call.ended', endHandler)

    // Start call
    agent._handleEvent({
      event: 'call.started',
      call_id: 'CA_002',
      from: '+1',
      to: '+2',
      direction: 'inbound',
    })

    // End call
    agent._handleEvent({
      event: 'call.ended',
      call_id: 'CA_002',
      reason: 'hangup',
      messages: [],
      duration_seconds: 30,
    })

    expect(endHandler).toHaveBeenCalledOnce()
    expect(endHandler.mock.calls[0][1]).toBe('hangup')
    expect(agent.calls.has('CA_002')).toBe(false)
  })

  it('proxies bot.word events from call to agent', () => {
    const { agent } = createAgent()
    markReady(agent)
    const handler = vi.fn()
    agent.on('bot.word', handler)

    // Start call
    agent._handleEvent({
      event: 'call.started',
      call_id: 'CA_003',
      from: '+1',
      to: '+2',
      direction: 'inbound',
    })

    // Bot word
    agent._handleEvent({
      event: 'bot.word',
      call_id: 'CA_003',
      word: 'Hello',
      word_index: 0,
      message_id: 'msg_1',
    })

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].word).toBe('Hello')
  })

  it('emits llm.tool_call on agent for server-side LLM', () => {
    const { agent } = createAgent()
    markReady(agent)
    const handler = vi.fn()
    agent.on('llm.tool_call', handler)

    // Start call
    agent._handleEvent({
      event: 'call.started',
      call_id: 'CA_004',
      from: '+1',
      to: '+2',
      direction: 'inbound',
    })

    // Tool call
    agent._handleEvent({
      event: 'llm.tool_call',
      call_id: 'CA_004',
      msg_id: 'msg_5',
      tool_calls: [{ id: 'tc_1', name: 'lookup', arguments: '{"id":"123"}' }],
    })

    expect(handler).toHaveBeenCalledOnce()
    // Signature: (call, data)
    expect(handler.mock.calls[0][0].id).toBe('CA_004')
    expect(handler.mock.calls[0][1].tool_calls).toHaveLength(1)
  })

  // ── _endAllCalls() ────────────────────────────────────

  it('_endAllCalls() ends all active calls', () => {
    const { agent } = createAgent()
    markReady(agent)

    // Create two calls
    agent._handleEvent({ event: 'call.started', call_id: 'CA_A', from: '+1', to: '+2', direction: 'inbound' })
    agent._handleEvent({ event: 'call.started', call_id: 'CA_B', from: '+3', to: '+4', direction: 'inbound' })
    expect(agent.calls.size).toBe(2)

    agent._endAllCalls('disconnected')
    expect(agent.calls.size).toBe(0)
  })

  // ── Reconnection: re-registers channels ───────────────

  it('_flushPending() re-registers all channels', () => {
    const { agent, send } = createAgent()
    markReady(agent)

    agent.addChannel('phone', '+15551111111')
    agent.addChannel('phone', '+15552222222')
    send.mockClear()

    // Simulate reconnect
    agent._endAllCalls('connection_lost')
    agent._flushPending()

    // Both channels should be re-registered
    const channelAdds = send.mock.calls.filter(c => c[0].event === 'channel.add')
    expect(channelAdds).toHaveLength(2)
  })
})
