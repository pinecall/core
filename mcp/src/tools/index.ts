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
import docsSearch from "./docs-search.js";
import knowledge from "./knowledge.js";

export const tools: ToolModule<any>[] = [
    whoami,
    setApiKey,
    docsSearch,
    knowledge,
];

export type { ToolModule, ToolContext } from "./types.js";
export { defineTool } from "./types.js";
