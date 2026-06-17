/**
 * Chat handler — server-side LLM chat events.
 *
 * Handles: llm.chat.started, llm.chat.chunk, llm.chat.ended,
 *          llm.chat.error, llm.tool_call (with chat- prefix)
 *
 * Business logic:
 *   - Creates a Call with transport="chat" on llm.chat.started
 *   - Emits call.started (same as voice/WA) so the developer's universal
 *     call.started handler runs setPromptVars, addContext, etc.
 *   - Fallback lazy Call creation on llm.chat.chunk if chat.started was missed
 */

import type { EventHandler, DispatchContext } from "../handler.js";
import type { WireEvent } from "../../protocol/wire.js";
import { Call } from "../../domain/call.js";
import { decodeEvent } from "../../protocol/codec.js";
import { forwardCallEvents } from "../proxy.js";
import { autoExecuteTools } from "./tool.js";
import type { ToolCallItem } from "../../protocol/events.js";



export class ChatHandler implements EventHandler {
    readonly events = [
        "llm.chat.started",
        "llm.chat.chunk",
        "llm.chat.ended",
        "llm.chat.error",
        "llm.tool_call",
        "chat.message",
        "chat.response",
    ] as const;

    handle(wire: WireEvent, ctx: DispatchContext): boolean {
        // Only handle chat-prefixed call_ids for llm.tool_call
        if (wire.event === "llm.tool_call") {
            const callId = wire.call_id as string;
            if (!callId || !callId.startsWith("chat-")) return false;
        }

        const agent = wire.agent_id ? ctx.agent(wire.agent_id) : null;
        if (!agent) return false;

        const callId = wire.call_id as string;
        if (!callId) return false;

        switch (wire.event) {
            case "llm.chat.started": {
                const call = new Call(
                    {
                        call_id: callId,
                        from: "chat",
                        to: agent.id,
                        direction: "inbound",
                        transport: "chat" as any,
                    },
                    (data) => agent.send(data),
                );

                agent._setCall(callId, call);
                forwardCallEvents(call, agent, call);

                // Emit chat.started — the entry point for chat sessions
                agent._emitWire("chat.started" as any, call);

                return true;
            }

            case "llm.chat.chunk": {
                // Lazy Call creation if chat.started was missed
                let call = agent._getCall(callId);
                if (!call) {
                    call = new Call(
                        {
                            call_id: callId,
                            from: "chat",
                            to: agent.id,
                            direction: "inbound",
                            transport: "chat" as any,
                        },
                        (data) => agent.send(data),
                    );
                    agent._setCall(callId, call);
                    forwardCallEvents(call, agent, call);
                    agent._emitWire("chat.started" as any, call);
                }

                // Emit as bot.speaking for consistency
                call._emitWire("bot.speaking", {
                    event: "bot.speaking",
                    callId,
                    messageId: (wire.message_id ?? "") as string,
                    text: (wire.token ?? wire.text ?? "") as string,
                });

                return true;
            }

            case "llm.chat.ended": {
                const call = agent._getCall(callId);
                if (call) {
                    call._applyEnd("chat_completed", wire);
                    agent._emitWire("call.ended", call, "chat_completed");
                    agent._deleteCall(callId);
                }
                return true;
            }

            case "llm.chat.error": {
                const call = agent._getCall(callId);
                if (call) {
                    call._applyEnd("chat_error", wire);
                    agent._emitWire("call.ended", call, "chat_error");
                    agent._deleteCall(callId);
                }
                return true;
            }

            case "chat.message": {
                const call = agent._getCall(callId);
                if (call) {
                    const text = (wire.text ?? "") as string;
                    call._pushMessage({ role: "user", content: text });
                    call._emitWire("user.message", { event: "user.message", callId, text });
                }
                return true;
            }

            case "chat.response": {
                const call = agent._getCall(callId);
                if (call) {
                    const text = (wire.text ?? "") as string;
                    call._pushMessage({ role: "assistant", content: text });
                    call._emitWire("bot.speaking", { event: "bot.speaking", callId, messageId: "", text });
                }
                return true;
            }

            case "llm.tool_call": {
                let call = agent._getCall(callId);
                if (!call) {
                    // Lazy creation for tool calls that arrive before chat.started
                    call = new Call(
                        {
                            call_id: callId,
                            from: "chat",
                            to: agent.id,
                            direction: "inbound",
                            transport: "chat" as any,
                        },
                        (data) => agent.send(data),
                    );
                    agent._setCall(callId, call);
                    forwardCallEvents(call, agent, call);
                    agent._emitWire("call.started", call);
                }

                const rawToolCalls = (wire.tool_calls ?? []) as Array<Record<string, unknown>>;
                const toolCalls: ToolCallItem[] = rawToolCalls.map(tc => ({
                    id: (tc.id ?? "") as string,
                    name: (tc.name ?? (tc.function as any)?.name ?? "") as string,
                    arguments: (tc.arguments ?? (tc.function as any)?.arguments ?? "{}") as string,
                }));

                const toolEvent = {
                    event: "llm.toolCall" as const,
                    callId,
                    toolCalls,
                    msgId: (wire.msg_id ?? "") as string,
                };
                call._emitWire("llm.toolCall", toolEvent);

                // Auto-execute registered tools (chat does NOT go through ToolHandler).
                // Without this, chat tool calls never get a result → server times out.
                const tools = agent._getTools();
                if (tools.length > 0) void autoExecuteTools(tools, toolEvent, call);

                return true;
            }

            default:
                return false;
        }
    }
}
