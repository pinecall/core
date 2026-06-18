/**
 * tool() — declarative tool definitions with Zod schema + auto-execution.
 *
 * Usage:
 * ```ts
 * import { tool } from "@pinecall/sdk";
 * import { z } from "zod";
 *
 * const openDoor = tool({
 *   name: "openDoor",
 *   description: "Opens the door if the code is valid",
 *   schema: z.object({ code: z.string().describe("5-digit code") }),
 *   execute: async ({ code }, call) => ({ success: VALID_CODES.has(code) }),
 * });
 * ```
 *
 * The returned Tool object is passed to `tools: [openDoor]` in agent config.
 * The SDK auto-executes matching tools on `llm.tool_call` events.
 */

import type { Call } from "./domain/call.js";

// ─── Public types ────────────────────────────────────────────────────────

export interface ToolConfig<T = any> {
    name: string;
    description: string;
    /** Zod schema (or any object with .parse() and ._def). */
    schema: ZodLike<T>;
    /** Execute function — receives parsed args + call. */
    execute: (args: T, call: Call) => unknown | Promise<unknown>;
    /**
     * Ephemeral tools — the result is used to generate the current reply but is
     * NOT persisted to conversation history (neither the LLM context for later
     * turns nor the saved transcript). Defaults to `false` (results are saved).
     * Use for sensitive lookups or large/noisy payloads you don't want to keep.
     */
    ephemeral?: boolean;
}

export interface Tool<T = any> {
    readonly name: string;
    readonly description: string;
    readonly schema: ZodLike<T>;
    readonly execute: (args: T, call: Call) => unknown | Promise<unknown>;
    /** Result is not persisted to history when true. */
    readonly ephemeral: boolean;
    /** @internal JSON Schema for wire protocol. */
    readonly _jsonSchema: Record<string, unknown>;
    /** @internal Convert to OpenAI function-calling wire format. */
    _toWire(): Record<string, unknown>;
}

/** Duck-typed Zod schema — anything with parse() and _def. */
interface ZodLike<T = any> {
    parse: (input: unknown) => T;
    _def: Record<string, any>;
    [key: string]: any;
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function tool<T>(config: ToolConfig<T>): Tool<T> {
    const jsonSchema = zodToJsonSchema(config.schema);

    return {
        name: config.name,
        description: config.description,
        schema: config.schema,
        execute: config.execute,
        ephemeral: config.ephemeral ?? false,
        _jsonSchema: jsonSchema,
        _toWire() {
            return {
                type: "function",
                function: {
                    name: config.name,
                    description: config.description,
                    parameters: jsonSchema,
                },
            };
        },
    };
}

// ─── Zod → JSON Schema micro-converter ──────────────────────────────────
//
// Handles the Zod types actually used in voice agent tools:
//   ZodObject, ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodArray,
//   ZodOptional, ZodNullable, ZodDefault, ZodLiteral, ZodEffects,
//   plus .describe() on any type.

function zodToJsonSchema(schema: ZodLike): Record<string, unknown> {
    return convertNode(schema);
}

function convertNode(node: ZodLike): Record<string, unknown> {
    const def = node._def;
    const typeName: string = def.typeName ?? "";
    let result: Record<string, unknown> = {};

    switch (typeName) {
        case "ZodObject": {
            result.type = "object";
            const shape = def.shape?.() ?? def.shape ?? {};
            const properties: Record<string, unknown> = {};
            const required: string[] = [];

            for (const [key, value] of Object.entries(shape)) {
                properties[key] = convertNode(value as ZodLike);
                if (!isOptional(value as ZodLike)) {
                    required.push(key);
                }
            }

            result.properties = properties;
            if (required.length > 0) result.required = required;
            break;
        }

        case "ZodString":
            result.type = "string";
            break;

        case "ZodNumber":
            result.type = "number";
            break;

        case "ZodBoolean":
            result.type = "boolean";
            break;

        case "ZodEnum":
            result.type = "string";
            result.enum = def.values;
            break;

        case "ZodArray":
            result.type = "array";
            if (def.type) {
                result.items = convertNode(def.type);
            }
            break;

        case "ZodOptional":
            result = convertNode(def.innerType);
            break;

        case "ZodNullable":
            result = convertNode(def.innerType);
            break;

        case "ZodDefault":
            result = convertNode(def.innerType);
            if (def.defaultValue !== undefined) {
                result.default = typeof def.defaultValue === "function"
                    ? def.defaultValue()
                    : def.defaultValue;
            }
            break;

        case "ZodLiteral":
            result.const = def.value;
            break;

        case "ZodEffects":
            // .refine() / .transform() — convert the inner schema
            result = convertNode(def.schema);
            break;

        default:
            // Unknown Zod type — pass through as empty object
            break;
    }

    // .describe() — Zod stores it on _def.description
    if (def.description) {
        result.description = def.description;
    }

    return result;
}

function isOptional(node: ZodLike): boolean {
    const typeName: string = node._def?.typeName ?? "";
    if (typeName === "ZodOptional") return true;
    if (typeName === "ZodDefault") return true;
    // Unwrap effects
    if (typeName === "ZodEffects") return isOptional(node._def.schema);
    return false;
}
