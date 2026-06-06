/**
 * Agent tests — channel management, event routing, call lifecycle.
 *
 * Uses a mock send function (no WebSocket). Tests the Agent class
 * in isolation from Pinecall client.
 *
 * Ported to the new architecture: Call creation and event routing
 * are now done through dispatch handlers + _apply* methods,
 * not through agent._handleEvent().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent } from '../src/domain/agent.js'
import { Call } from '../src/domain/call.js'
import { forwardCallEvents } from '../src/dispatch/proxy.js'
import { decodeEvent } from '../src/protocol/codec.js'

function createAgent(id = 'test-agent', config = {}) {
  const send = vi.fn()
  const agent = new Agent(id, config, send)
  return { agent, send }
}

/** Simulate server readiness (normally triggered by Pinecall after agent.created). */
function markReady(agent: Agent) {
  agent._flushPending()
}

/** Simulate a call.started event (what LifecycleHandler does). */
function startCall(agent: Agent, data: Record<string, unknown>): Call {
  const callId = data.call_id as string
  const call = new Call(
    {
      call_id: callId,
      from: (data.from ?? '') as string,
      to: (data.to ?? '') as string,
      direction: (data.direction ?? 'inbound') as 'inbound' | 'outbound',
      transport: (data.transport as any) ?? 'unknown',
    },
    (d) => agent.send(d),
  )
  agent._setCall(callId, call)
  forwardCallEvents(call, agent, call)
  agent._emitWire('call.started', call)
  return call
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
    agent.addPhoneNumber('+15551234567')
    // send should NOT have been called — buffered
    expect(send).not.toHaveBeenCalled()
  })

  it('flushes buffered messages on _flushPending()', () => {
    const { agent, send } = createAgent()
    agent.addPhoneNumber('+15551234567')
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

    agent.addPhoneNumber('+15559999999')
    expect(send).toHaveBeenCalledOnce()
  })

  // ── Channel management ────────────────────────────────

  it('phone() sends channel.add with agent_id', () => {
    const { agent, send } = createAgent('my-bot')
    markReady(agent)
    agent.addPhoneNumber('+15551234567')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'channel.add',
        agent_id: 'my-bot',
        type: 'phone',
        ref: '+15551234567',
      }),
    )
  })

  it('phone() validates E.164 phone numbers', () => {
    const { agent } = createAgent()
    markReady(agent)
    expect(() => agent.addPhoneNumber('abc')).toThrow('Invalid phone number')
  })

  it('phone() allows SIP URIs', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    agent.addPhoneNumber('sip:bot@trunk.twilio.com')
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'sip:bot@trunk.twilio.com' }),
    )
  })

  it('_addChannel("webrtc") works without ref', () => {
    const { agent, send } = createAgent()
    markReady(agent)
    agent._addChannel('webrtc')
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

  // ── Call routing (via direct Call/Agent interaction) ───

  it('call.started creates a Call and emits event', () => {
    const { agent } = createAgent()
    markReady(agent)
    const handler = vi.fn()
    agent.on('call.started', handler)

    startCall(agent, {
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
    const call = startCall(agent, {
      call_id: 'CA_002',
      from: '+1',
      to: '+2',
      direction: 'inbound',
    })

    // End call
    call._applyEnd('hangup', { messages: [], duration_seconds: 30 })
    agent._emitWire('call.ended', call, 'hangup')
    agent._deleteCall('CA_002')

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
    const call = startCall(agent, {
      call_id: 'CA_003',
      from: '+1',
      to: '+2',
      direction: 'inbound',
    })

    // Emit bot.word on call — should proxy to agent
    call._emitWire('bot.word', decodeEvent({
      event: 'bot.word',
      call_id: 'CA_003',
      word: 'Hello',
      word_index: 0,
      message_id: 'msg_1',
    }))

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].word).toBe('Hello')
  })

  it('emits llm.tool_call on agent for server-side LLM', () => {
    const { agent } = createAgent()
    markReady(agent)
    const handler = vi.fn()
    agent.on('llm.tool_call', handler)

    // Start call
    const call = startCall(agent, {
      call_id: 'CA_004',
      from: '+1',
      to: '+2',
      direction: 'inbound',
    })

    // Emit tool call on call — should proxy to agent
    call._emitWire('llm.tool_call', {
      event: 'llm.tool_call',
      callId: 'CA_004',
      toolCalls: [{ id: 'tc_1', name: 'lookup', arguments: '{"id":"123"}' }],
      msgId: 'msg_5',
    })

    expect(handler).toHaveBeenCalledOnce()
    const data = handler.mock.calls[0][0]
    expect(data.toolCalls).toHaveLength(1)
    expect(data.toolCalls[0].id).toBe('tc_1')
    expect(data.toolCalls[0].name).toBe('lookup')
    expect(data.msgId).toBe('msg_5')
    expect(handler.mock.calls[0][1].id).toBe('CA_004')
  })

  // ── _endAllCalls() ────────────────────────────────────

  it('_endAllCalls() ends all active calls', () => {
    const { agent } = createAgent()
    markReady(agent)

    // Create two calls
    startCall(agent, { call_id: 'CA_A', from: '+1', to: '+2', direction: 'inbound' })
    startCall(agent, { call_id: 'CA_B', from: '+3', to: '+4', direction: 'inbound' })
    expect(agent.calls.size).toBe(2)

    agent._endAllCalls('disconnected')
    expect(agent.calls.size).toBe(0)
  })

  // ── Reconnection: re-registers channels ───────────────

  it('_flushPending() re-registers all channels', () => {
    const { agent, send } = createAgent()
    markReady(agent)

    agent.addPhoneNumber('+15551111111')
    agent.addPhoneNumber('+15552222222')
    send.mockClear()

    // Simulate reconnect
    agent._endAllCalls('connection_lost')
    agent._flushPending()

    // Both channels should be re-registered
    const channelAdds = send.mock.calls.filter(c => c[0].event === 'channel.add')
    expect(channelAdds).toHaveLength(2)
  })
})
