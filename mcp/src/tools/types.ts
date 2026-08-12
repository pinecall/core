/**
 * The tool contract. One file per tool, one shape.
 *
 * `manual` is that tool's section of the server `instructions` — the manual
 * lives NEXT TO the handler so the two cannot drift apart. There is no second
 * place where tools are documented.
 */

import type { ZodRawShape } from "zod";
import type { Session } from "../session.js";

export interface ToolContext {
    session: Session;
}

export interface ToolModule<S extends ZodRawShape = ZodRawShape> {
    /** MCP tool name, snake_case. */
    name: string;
    /** One line, shown in tools/list. */
    description: string;
    /** Zod raw shape — the input schema. `{}` for a no-arg tool. */
    schema: S;
    /** The tool's section of the server instructions. Markdown, no heading. */
    manual: string;
    /** Returns anything JSON-serializable; the server wraps it. */
    handler(args: any, ctx: ToolContext): Promise<unknown>;
}

/** Identity helper — gives inference without repeating the generic. */
export function defineTool<S extends ZodRawShape>(t: ToolModule<S>): ToolModule<S> {
    return t;
}
