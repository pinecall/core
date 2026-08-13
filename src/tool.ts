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
    /**
     * Fire-and-forget / UI-only tools — after this tool's result the server does
     * NOT generate a follow-up assistant turn. Use for tools whose result only
     * drives the UI (suggested-question chips, a toast, a state mutation) and
     * should NOT produce another spoken/written reply. The result still reaches
     * the client via `llm.tool_result`. Defaults to `false`.
     *
     * Only takes effect when EVERY tool called in that round is `noFollowup`; a
     * mixed round (a normal tool + a noFollowup tool) still replies, because the
     * normal tool's result needs one.
     */
    noFollowup?: boolean;
}

export interface Tool<T = any> {
    readonly name: string;
    readonly description: string;
    readonly schema: ZodLike<T>;
    readonly execute: (args: T, call: Call) => unknown | Promise<unknown>;
    /** Result is not persisted to history when true. */
    readonly ephemeral: boolean;
    /** No follow-up assistant turn is generated after this tool when true. */
    readonly noFollowup: boolean;
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
        noFollowup: config.noFollowup ?? false,
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
    // Zod 4 renamed the discriminant: `_def.typeName` ("ZodString") became
    // `_def.type` ("string"). A v4 schema fed to the v3 switch matched NOTHING,
    // fell through to the default, and every tool went to the LLM as
    // `parameters: {}` — the model then "correctly" called it with no args and
    // the SDK-side Zod validation rejected what the model was never told about.
    // Silent, because tests asserted on `.schema` (the Zod object), never on
    // the generated wire schema. Both formats are handled from here on.
    if (typeof def.type === "string" && def.typeName === undefined) {
        return convertNodeV4(node);
    }
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

/**
 * Zod 4 branch. Same JSON Schema output as the v3 switch, from v4's internals:
 * `_def.type` is lowercase ("object"), object shape is a plain object (not a
 * thunk), enums live in `_def.entries`, array element in `_def.element`, and
 * `.transform()/.refine()` compose through "pipe" (`_def.in`). `.describe()`
 * no longer writes `_def.description` — it registers metadata that surfaces on
 * the schema's own `.description` getter, which v3 also has, so the caller
 * reads `node.description` first for both.
 */
function convertNodeV4(node: ZodLike): Record<string, unknown> {
    const def = node._def;
    let result: Record<string, unknown> = {};

    switch (def.type) {
        case "object": {
            result.type = "object";
            const shape = typeof def.shape === "function" ? def.shape() : (def.shape ?? {});
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

        case "string":
            result.type = "string";
            break;

        case "number":
        case "int":
            result.type = "number";
            break;

        case "boolean":
            result.type = "boolean";
            break;

        case "enum":
            result.type = "string";
            result.enum = def.entries ? Object.values(def.entries) : def.values;
            break;

        case "array":
            result.type = "array";
            if (def.element) {
                result.items = convertNode(def.element);
            }
            break;

        case "optional":
        case "nullable":
            result = convertNode(def.innerType);
            break;

        case "default":
            result = convertNode(def.innerType);
            if (def.defaultValue !== undefined) {
                result.default = typeof def.defaultValue === "function"
                    ? def.defaultValue()
                    : def.defaultValue;
            }
            break;

        case "literal": {
            // v4 literals hold an ARRAY of values (z.literal(["a", "b"]) is legal).
            const values: unknown[] = def.values ?? [];
            if (values.length === 1) result.const = values[0];
            else if (values.length > 1) result.enum = values;
            break;
        }

        case "pipe":
            // .transform() / piped refinements — the LLM's contract is the INPUT
            result = convertNode(def.in);
            break;

        default:
            // Unknown Zod type — pass through as empty object
            break;
    }

    const description = node.description ?? def.description;
    if (description) {
        result.description = description;
    }

    return result;
}

function isOptional(node: ZodLike): boolean {
    const def = node._def ?? {};
    // Zod 4 (lowercase `type` discriminant)
    if (typeof def.type === "string" && def.typeName === undefined) {
        if (def.type === "optional") return true;
        if (def.type === "default") return true;
        if (def.type === "pipe") return isOptional(def.in);
        return false;
    }
    const typeName: string = def.typeName ?? "";
    if (typeName === "ZodOptional") return true;
    if (typeName === "ZodDefault") return true;
    // Unwrap effects
    if (typeName === "ZodEffects") return isOptional(node._def.schema);
    return false;
}
