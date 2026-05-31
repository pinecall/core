/**
 * tool() — tests for the declarative tool API.
 *
 * Covers:
 *   - tool() factory creates valid Tool objects
 *   - Zod → JSON Schema conversion (all supported types)
 *   - _toWire() produces OpenAI function-calling format
 *   - Auto-execution via ToolHandler
 */

import { describe, it, expect, vi } from "vitest";
import { tool } from "../src/tool.js";
import { Agent } from "../src/domain/agent.js";
import { Call } from "../src/domain/call.js";
import type { ToolCallEvent } from "../src/protocol/events.js";

// ─── Minimal Zod-like mocks ─────────────────────────────────────────────
// We duck-type Zod so tests don't need the real zod dependency.

function zodString(description?: string) {
    return {
        _def: { typeName: "ZodString", ...(description ? { description } : {}) },
        parse: (v: unknown) => String(v),
    };
}

function zodNumber(description?: string) {
    return {
        _def: { typeName: "ZodNumber", ...(description ? { description } : {}) },
        parse: (v: unknown) => Number(v),
    };
}

function zodBoolean() {
    return {
        _def: { typeName: "ZodBoolean" },
        parse: (v: unknown) => Boolean(v),
    };
}

function zodEnum(values: string[]) {
    return {
        _def: { typeName: "ZodEnum", values },
        parse: (v: unknown) => {
            if (!values.includes(v as string)) throw new Error(`Invalid enum value: ${v}`);
            return v;
        },
    };
}

function zodOptional(inner: any) {
    return {
        _def: { typeName: "ZodOptional", innerType: inner },
        parse: (v: unknown) => v === undefined ? undefined : inner.parse(v),
    };
}

function zodArray(inner: any) {
    return {
        _def: { typeName: "ZodArray", type: inner },
        parse: (v: unknown) => (v as any[]).map(inner.parse),
    };
}

function zodObject(shape: Record<string, any>, description?: string) {
    return {
        _def: {
            typeName: "ZodObject",
            shape: () => shape,
            ...(description ? { description } : {}),
        },
        parse: (v: unknown) => {
            const obj = v as Record<string, unknown>;
            const result: Record<string, unknown> = {};
            for (const [key, schema] of Object.entries(shape)) {
                if (key in obj) result[key] = (schema as any).parse(obj[key]);
                else if ((schema as any)._def.typeName !== "ZodOptional") {
                    throw new Error(`Missing required field: ${key}`);
                }
            }
            return result;
        },
    };
}

// ─── tool() factory ──────────────────────────────────────────────────────

describe("tool()", () => {
    it("creates a Tool with name, description, schema, execute", () => {
        const t = tool({
            name: "greet",
            description: "Says hello",
            schema: zodObject({ name: zodString() }) as any,
            execute: ({ name }) => `Hello ${name}`,
        });

        expect(t.name).toBe("greet");
        expect(t.description).toBe("Says hello");
        expect(typeof t.execute).toBe("function");
        expect(typeof t._toWire).toBe("function");
    });

    it("execute receives parsed args", async () => {
        const t = tool({
            name: "add",
            description: "Adds two numbers",
            schema: zodObject({ a: zodNumber(), b: zodNumber() }) as any,
            execute: ({ a, b }) => a + b,
        });

        const result = await t.execute({ a: 3, b: 4 }, {} as any);
        expect(result).toBe(7);
    });
});

// ─── Zod → JSON Schema ──────────────────────────────────────────────────

describe("zodToJsonSchema", () => {
    it("converts ZodObject with required fields", () => {
        const t = tool({
            name: "test",
            description: "test",
            schema: zodObject({
                code: zodString("5-digit code"),
                count: zodNumber(),
            }) as any,
            execute: () => {},
        });

        expect(t._jsonSchema).toEqual({
            type: "object",
            properties: {
                code: { type: "string", description: "5-digit code" },
                count: { type: "number" },
            },
            required: ["code", "count"],
        });
    });

    it("handles optional fields", () => {
        const t = tool({
            name: "test",
            description: "test",
            schema: zodObject({
                name: zodString(),
                email: zodOptional(zodString()),
            }) as any,
            execute: () => {},
        });

        expect(t._jsonSchema.required).toEqual(["name"]);
        expect((t._jsonSchema.properties as any).email).toEqual({ type: "string" });
    });

    it("handles enum fields", () => {
        const t = tool({
            name: "test",
            description: "test",
            schema: zodObject({
                role: zodEnum(["admin", "user"]),
            }) as any,
            execute: () => {},
        });

        expect((t._jsonSchema.properties as any).role).toEqual({
            type: "string",
            enum: ["admin", "user"],
        });
    });

    it("handles array fields", () => {
        const t = tool({
            name: "test",
            description: "test",
            schema: zodObject({
                tags: zodArray(zodString()),
            }) as any,
            execute: () => {},
        });

        expect((t._jsonSchema.properties as any).tags).toEqual({
            type: "array",
            items: { type: "string" },
        });
    });

    it("handles boolean fields", () => {
        const t = tool({
            name: "test",
            description: "test",
            schema: zodObject({ flag: zodBoolean() }) as any,
            execute: () => {},
        });

        expect((t._jsonSchema.properties as any).flag).toEqual({ type: "boolean" });
    });
});

// ─── _toWire() ───────────────────────────────────────────────────────────

describe("_toWire()", () => {
    it("produces OpenAI function-calling format", () => {
        const t = tool({
            name: "openDoor",
            description: "Opens the door",
            schema: zodObject({
                code: zodString("5-digit code"),
            }) as any,
            execute: () => {},
        });

        expect(t._toWire()).toEqual({
            type: "function",
            function: {
                name: "openDoor",
                description: "Opens the door",
                parameters: {
                    type: "object",
                    properties: {
                        code: { type: "string", description: "5-digit code" },
                    },
                    required: ["code"],
                },
            },
        });
    });
});

// ─── Auto-execution integration ─────────────────────────────────────────

describe("auto-execution", () => {
    function makeAgent(tools: any[]) {
        const send = vi.fn();
        const agent = new Agent("test-agent", { tools }, send);
        return { agent, send };
    }

    function makeCall(send: ReturnType<typeof vi.fn>) {
        return new Call(
            { call_id: "call-1", from: "+1", to: "+2", direction: "inbound" },
            send,
        );
    }

    it("auto-executes tools and sends toolResult", async () => {
        const executeFn = vi.fn().mockResolvedValue({ success: true });
        const openDoor = tool({
            name: "openDoor",
            description: "Opens the door",
            schema: zodObject({ code: zodString() }) as any,
            execute: executeFn,
        });

        const { agent, send } = makeAgent([openDoor]);
        const call = makeCall(send);
        agent._setCall("call-1", call);

        // Simulate llm.tool_call event
        const event: ToolCallEvent = {
            event: "llm.tool_call",
            callId: "call-1",
            toolCalls: [{ id: "tc-1", name: "openDoor", arguments: '{"code":"12345"}' }],
            msgId: "msg-1",
        };

        call._emitWire("llm.tool_call", event);

        // Import and run the handler directly
        const { ToolHandler } = await import("../src/dispatch/handlers/tool.js");
        const handler = new ToolHandler();

        const wireEvent = {
            event: "llm.tool_call",
            agent_id: "test-agent",
            call_id: "call-1",
            msg_id: "msg-1",
            tool_calls: [{ id: "tc-1", name: "openDoor", arguments: '{"code":"12345"}' }],
        };

        handler.handle(wireEvent, {
            agent: () => agent,
            call: (a, id) => a._getCall(id) ?? null,
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            send: () => {},
            onConnected: () => {},
            client: { _emitWire: () => {}, _getAgent: () => undefined },
        } as any);

        // Wait for async auto-execution
        await new Promise((r) => setTimeout(r, 50));

        expect(executeFn).toHaveBeenCalledWith({ code: "12345" }, call);
        expect(send).toHaveBeenCalledWith({
            event: "llm.tool_result",
            call_id: "call-1",
            msg_id: "msg-1",
            results: [{ tool_call_id: "tc-1", result: { success: true } }],
        });
    });

    it("returns error result for unknown tool names", async () => {
        const openDoor = tool({
            name: "openDoor",
            description: "Opens the door",
            schema: zodObject({ code: zodString() }) as any,
            execute: () => ({ success: true }),
        });

        const { agent, send } = makeAgent([openDoor]);
        const call = makeCall(send);
        agent._setCall("call-1", call);

        const { ToolHandler } = await import("../src/dispatch/handlers/tool.js");
        const handler = new ToolHandler();

        handler.handle({
            event: "llm.tool_call",
            agent_id: "test-agent",
            call_id: "call-1",
            msg_id: "msg-2",
            tool_calls: [{ id: "tc-2", name: "unknownTool", arguments: "{}" }],
        }, {
            agent: () => agent,
            call: (a, id) => a._getCall(id) ?? null,
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            send: () => {},
            onConnected: () => {},
            client: { _emitWire: () => {}, _getAgent: () => undefined },
        } as any);

        await new Promise((r) => setTimeout(r, 50));

        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "llm.tool_result",
                msg_id: "msg-2",
                results: [{ tool_call_id: "tc-2", result: { error: "Unknown tool: unknownTool" } }],
            }),
        );
    });

    it("returns error result when schema validation fails", async () => {
        const strictTool = tool({
            name: "strict",
            description: "Requires a number",
            schema: {
                _def: { typeName: "ZodObject", shape: () => ({}) },
                parse: () => { throw new Error("Validation failed: expected number"); },
            } as any,
            execute: () => ({ ok: true }),
        });

        const { agent, send } = makeAgent([strictTool]);
        const call = makeCall(send);
        agent._setCall("call-1", call);

        const { ToolHandler } = await import("../src/dispatch/handlers/tool.js");
        const handler = new ToolHandler();

        handler.handle({
            event: "llm.tool_call",
            agent_id: "test-agent",
            call_id: "call-1",
            msg_id: "msg-3",
            tool_calls: [{ id: "tc-3", name: "strict", arguments: '{"bad":"data"}' }],
        }, {
            agent: () => agent,
            call: (a, id) => a._getCall(id) ?? null,
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            send: () => {},
            onConnected: () => {},
            client: { _emitWire: () => {}, _getAgent: () => undefined },
        } as any);

        await new Promise((r) => setTimeout(r, 50));

        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "llm.tool_result",
                msg_id: "msg-3",
                results: [{ tool_call_id: "tc-3", result: { error: "Validation failed: expected number" } }],
            }),
        );
    });

    it("passes call as second argument to execute", async () => {
        const executeFn = vi.fn().mockResolvedValue("done");
        const myTool = tool({
            name: "test",
            description: "test",
            schema: zodObject({}) as any,
            execute: executeFn,
        });

        const { agent, send } = makeAgent([myTool]);
        const call = makeCall(send);
        agent._setCall("call-1", call);

        const { ToolHandler } = await import("../src/dispatch/handlers/tool.js");
        const handler = new ToolHandler();

        handler.handle({
            event: "llm.tool_call",
            agent_id: "test-agent",
            call_id: "call-1",
            msg_id: "msg-4",
            tool_calls: [{ id: "tc-4", name: "test", arguments: "{}" }],
        }, {
            agent: () => agent,
            call: (a, id) => a._getCall(id) ?? null,
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            send: () => {},
            onConnected: () => {},
            client: { _emitWire: () => {}, _getAgent: () => undefined },
        } as any);

        await new Promise((r) => setTimeout(r, 50));

        expect(executeFn).toHaveBeenCalledTimes(1);
        const callArg = executeFn.mock.calls[0][1];
        expect(callArg).toBeInstanceOf(Call);
        expect(callArg.id).toBe("call-1");
    });
});
