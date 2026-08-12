/**
 * The tool registry.
 *
 * Adding a tool = adding a file next to this one + one import line + one
 * array entry. Nothing else in the server changes: registration, the
 * instructions assembly and the error envelope all iterate this list (OCP).
 *
 * Order matters — it is the order the tools appear in the `instructions`
 * manual, so keep it in journey order (auth → discover → configure → iterate → debug).
 */

import type { ToolModule } from "./types.js";
import whoami from "./whoami.js";
import setApiKey from "./set-api-key.js";
import listAgents from "./list-agents.js";

export const tools: ToolModule<any>[] = [
    whoami,
    setApiKey,
    listAgents,
];

export type { ToolModule, ToolContext } from "./types.js";
export { defineTool } from "./types.js";
