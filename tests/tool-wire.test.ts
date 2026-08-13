/**
 * _toWire() against REAL zod, both majors.
 *
 * This test exists because of a production outage it would have caught:
 * tool.test.ts duck-types zod in the v3 `_def.typeName` shape, so the
 * converter was never exercised against what a consumer actually installs.
 * Zod 4 renamed the discriminant (`_def.typeName` → `_def.type`), the v3
 * switch matched nothing, and every tool reached the LLM as
 * `parameters: {}` — 38/38 green while the whole tool layer was dead
 * (portia, 2026-08-13: identifyVisitor called with no name, openDoor with
 * no code, all five tools).
 *
 * The contract under test is the WIRE schema — the exact bytes the LLM
 * sees — not the Zod object. If either zod major changes its internals
 * again, this file goes red before an agent goes mute.
 */

import { describe, it, expect } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod-v3";
import { tool } from "../src/tool.js";

// The portia schemas, verbatim in spirit: the exact combination that was
// silently broken (object / string / enum / optional / describe / strict).
function portiaLikeTools(z: typeof z3 | typeof z4) {
    const identifyVisitor = tool({
        name: "identifyVisitor",
        description: "Identify the visitor",
        schema: z
            .object({
                name: z.string().describe("Visitor's full name"),
                company: z.string().optional(),
            })
            .strict() as any,
        execute: async () => ({}),
    });
    const openDoor = tool({
        name: "openDoor",
        description: "Open the door",
        schema: z.object({
            code: z.string().describe("5-digit access code"),
            door: z.enum(["A", "B"]),
        }) as any,
        execute: async () => ({}),
    });
    return { identifyVisitor, openDoor };
}

function params(t: { _toWire(): Record<string, unknown> }): any {
    return (t._toWire() as any).function.parameters;
}

for (const [major, z] of [
    ["zod 4", z4],
    ["zod 3", z3],
] as const) {
    describe(`_toWire with real ${major}`, () => {
        const { identifyVisitor, openDoor } = portiaLikeTools(z as any);

        it("emits the parameters — never an empty schema", () => {
            const p = params(identifyVisitor);
            expect(p.type).toBe("object");
            expect(Object.keys(p.properties)).toEqual(["name", "company"]);
            expect(p.required).toEqual(["name"]);
        });

        it("carries types, descriptions and enums through", () => {
            const p = params(openDoor);
            expect(p.properties.code).toMatchObject({
                type: "string",
                description: "5-digit access code",
            });
            expect(p.properties.door.type).toBe("string");
            expect([...p.properties.door.enum]).toEqual(["A", "B"]);
            expect(p.required).toEqual(["code", "door"]);
        });

        it("number, boolean, array, default and literal survive", () => {
            const t = tool({
                name: "kitchenSink",
                description: "every supported type",
                schema: (z as any).object({
                    n: (z as any).number(),
                    b: (z as any).boolean(),
                    tags: (z as any).array((z as any).string()),
                    lang: (z as any).string().default("es"),
                    mode: (z as any).literal("fast"),
                }),
                execute: async () => ({}),
            });
            const p = params(t);
            expect(p.properties.n.type).toBe("number");
            expect(p.properties.b.type).toBe("boolean");
            expect(p.properties.tags).toMatchObject({ type: "array", items: { type: "string" } });
            expect(p.properties.lang.default).toBe("es");
            expect(p.properties.mode.const).toBe("fast");
            // default → not required; everything else is
            expect(p.required).toEqual(["n", "b", "tags", "mode"]);
        });

        it("the whole wire envelope is OpenAI function-calling shaped", () => {
            const wire = identifyVisitor._toWire() as any;
            expect(wire.type).toBe("function");
            expect(wire.function.name).toBe("identifyVisitor");
            expect(wire.function.description).toBe("Identify the visitor");
            expect(wire.function.parameters.properties).toBeDefined();
        });
    });
}
