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
import getDoc from "./get-doc.js";
import knowledge from "./knowledge.js";
import listAgents from "./list-agents.js";
import configureAgent from "./configure-agent.js";
import runAgent from "./run-agent.js";
import chat from "./chat.js";
import listPhones from "./list-phones.js";
import listCalls from "./list-calls.js";
import getCall from "./get-call.js";
import listModels from "./list-models.js";
import listVoices from "./list-voices.js";
import playVoice from "./play-voice.js";
import subscribe from "./subscribe.js";
import byok from "./byok.js";

export const tools: ToolModule<any>[] = [
    whoami,
    setApiKey,
    docsSearch,
    getDoc,
    knowledge,
    listAgents,
    configureAgent,
    // code tools need a process — the user's own file, run like `pinecall run`
    runAgent,
    chat,
    listPhones,
    // debug — the call log, last leg of the journey
    listCalls,
    getCall,
    listModels,
    listVoices,
    playVoice,
    // billing — the human's side of the journey: plan, credits, a payment link
    subscribe,
    byok,
];

export type { ToolModule, ToolContext } from "./types.js";
export { defineTool } from "./types.js";
