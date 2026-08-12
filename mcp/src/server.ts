/**
 * The MCP server: registry in, McpServer out.
 *
 * Nothing here knows about any individual tool — it iterates `tools`. The
 * single error envelope lives here too, so every handler can just throw and
 * the key can never leak through a stack trace (everything is redacted).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools as defaultTools } from "./tools/index.js";
import type { ToolModule } from "./tools/types.js";
import { buildInstructions } from "./instructions.js";
import { Session } from "./session.js";

export const VERSION = "0.1.0";

export interface CreateServerOptions {
    session?: Session;
    tools?: ToolModule<any>[];
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
    const session = opts.session ?? new Session();
    const tools = opts.tools ?? defaultTools;

    const server = new McpServer(
        { name: "@pinecall/mcp", version: VERSION },
        { instructions: buildInstructions(tools) },
    );

    for (const tool of tools) {
        server.registerTool(
            tool.name,
            { description: tool.description, inputSchema: tool.schema },
            async (args: any) => {
                try {
                    const result = await tool.handler(args ?? {}, { session });
                    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: session.redact(message) }],
                    };
                }
            },
        );
    }

    return server;
}
