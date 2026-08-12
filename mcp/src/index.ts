/**
 * `pinecall-mcp` — stdio entrypoint.
 *
 * stdout is the MCP transport: nothing may ever be written to it but protocol
 * frames. Diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export { createServer, VERSION } from "./server.js";
export { Session, MissingApiKeyError } from "./session.js";
export { buildInstructions, PLAYBOOK } from "./instructions.js";
export { tools } from "./tools/index.js";
export { defineTool } from "./tools/types.js";
export type { ToolModule, ToolContext } from "./tools/types.js";

export async function main(): Promise<void> {
    const server = createServer();
    await server.connect(new StdioServerTransport());
}

// Run only when executed as the binary, not when imported by a test.
const invokedDirectly =
    process.argv[1] !== undefined &&
    /(?:^|[\\/])(index\.(?:ts|js)|pinecall-mcp)$/.test(process.argv[1]);

if (invokedDirectly) {
    main().catch((err) => {
        console.error("[pinecall-mcp] fatal:", err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
