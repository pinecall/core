/**
 * Tool handler — server-side LLM tool call events.
 *
 * Handles: llm.tool_call (non-chat only — chat tool calls handled by chat.ts)
 *
 * Business logic:
 *   - §7.6 Filter re-emissions (server may re-send; only emit once per msgId)
 *   - Camelize tool_calls → toolCalls
 *   - Auto-execute Tool objects registered on the agent
 *   - Emit on call + agent (via proxy)
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import type { ToolCallEvent, ToolCallItem } from "../../protocol/events.js";
import type { Agent } from "../../domain/agent.js";

export class ToolHandler implements EventHandler {
    readonly events = ["llm.tool_call"] as const;

    /** Track emitted msg_ids to prevent duplicate emissions. */
    #emittedMsgIds = new Set<string>();

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        // Chat tool calls are handled by the ChatHandler
        if (wire.call_id && (wire.call_id as string).startsWith("chat-")) {
            return false; // Let ChatHandler handle it
        }

        const callId = wire.call_id as string;
        if (!callId) return false;

        // Resolve agent — try wire.agent_id first, then search all agents for the call
        let agent: Agent | null = wire.agent_id
            ? ctx.agent(wire.agent_id)
            : null;

        if (!agent) {
            // Server didn't include agent_id (WhatsApp, legacy voice) —
            // search all agents for one that owns this call or has tools
            agent = this.#findAgentByCall(callId, ctx);
        }
        if (!agent) return false;

        const call = agent._getCall(callId);

        const msgId = (wire.msg_id ?? wire.message_id ?? "") as string;

        // Deduplicate — server may re-send tool calls
        if (msgId && this.#emittedMsgIds.has(msgId)) {
            return true;
        }
        if (msgId) this.#emittedMsgIds.add(msgId);

        // Transform wire tool_calls → SDK toolCalls
        const rawToolCalls = (wire.tool_calls ?? []) as Array<Record<string, unknown>>;
        const toolCalls: ToolCallItem[] = rawToolCalls.map(tc => ({
            id: (tc.id ?? "") as string,
            name: (tc.name ?? (tc.function as any)?.name ?? "") as string,
            arguments: (tc.arguments ?? (tc.function as any)?.arguments ?? "{}") as string,
        }));

        const event: ToolCallEvent = {
            event: "llm.tool_call",
            callId,
            toolCalls,
            msgId,
        };

        // Emit event on call (so agent proxy picks it up too)
        if (call) {
            call._emitWire("llm.tool_call", event);
            // Push tool_calls to incremental history
            call._pushMessage({
                role: "assistant",
                tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                })),
            });
        } else {
            // No Call object (WhatsApp sessions) — emit directly on agent
            agent._emitWire("llm.tool_call", event);
        }

        // Auto-execute registered Tool objects
        const tools = agent._getTools();
        if (tools.length > 0) {
            if (call) {
                this.#autoExecute(tools, event, call);
            } else {
                // WhatsApp: build a lightweight proxy with toolResult
                this.#autoExecute(tools, event, {
                    toolResult: (mId: string, results: Array<{ toolCallId: string; result: unknown }>) => {
                        ctx.send({
                            event: "llm.tool_result",
                            call_id: callId,
                            msg_id: mId,
                            results: results.map(r => ({
                                tool_call_id: r.toolCallId,
                                result: r.result,
                            })),
                        });
                    },
                } as any);
            }
        }

        return true;
    }

    /** Find the agent that owns the given call, or the first agent with tools. */
    #findAgentByCall(callId: string, ctx: DispatchContext): Agent | null {
        const agents = ctx.client._allAgents();

        // First pass: find agent that owns the call
        for (const a of agents) {
            if (a._getCall(callId)) return a;
        }

        // Second pass: find agent with tools (for WhatsApp where no Call object exists)
        for (const a of agents) {
            if (a._getTools().length > 0) return a;
        }

        return null;
    }

    async #autoExecute(
        tools: Array<{ name: string; schema: { parse: (input: unknown) => any }; execute: (args: any, call: any) => unknown | Promise<unknown> }>,
        event: ToolCallEvent,
        call: { toolResult: (msgId: string, results: Array<{ toolCallId: string; result: unknown }>) => void },
    ): Promise<void> {
        const toolMap = new Map(tools.map(t => [t.name, t]));
        const names = event.toolCalls.map(tc => tc.name);
        console.log(`🔧 tool_call [${names.join(", ")}] msgId=${event.msgId.slice(0, 12)}`);

        const results = await Promise.all(
            event.toolCalls.map(async (tc) => {
                const t = toolMap.get(tc.name);
                if (!t) {
                    console.log(`  ❌ ${tc.name} → unknown tool`);
                    return { toolCallId: tc.id, result: { error: `Unknown tool: ${tc.name}` } };
                }

                try {
                    const args = t.schema.parse(JSON.parse(tc.arguments));
                    console.log(`  ⚙️  ${tc.name}(${JSON.stringify(args).slice(0, 120)})`);
                    const result = await t.execute(args, call as any);
                    const preview = JSON.stringify(result).slice(0, 200);
                    console.log(`  ✅ ${tc.name} → ${preview}`);
                    return { toolCallId: tc.id, result };
                } catch (err: any) {
                    console.log(`  ❌ ${tc.name} → error: ${err.message ?? err}`);
                    return { toolCallId: tc.id, result: { error: err.message ?? String(err) } };
                }
            }),
        );

        call.toolResult(event.msgId, results);

        // Push tool results to incremental history
        if ("_pushMessage" in call) {
            for (const r of results) {
                (call as any)._pushMessage({
                    role: "tool",
                    tool_call_id: r.toolCallId,
                    content: typeof r.result === "string" ? r.result : JSON.stringify(r.result),
                });
            }
        }
    }
}

