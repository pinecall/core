/**
 * `@pinecall/sdk/console` — the pieces the `pinecall run` console is built from,
 * published so the web app can import the SAME code the terminal runs on.
 *
 * Browser-clean by construction: the transcript reducer is a pure, dependency-
 * free state machine and the calls model is a thin read layer over it. The HTTP
 * server (node:http, node:fs) is deliberately NOT exported here — it lives in
 * the runner bundle, where Node is a given.
 */

export * from "./transcript-reducer.js";
export * from "./calls-model.js";
