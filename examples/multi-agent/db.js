/**
 * Simple JSON file database.
 *
 * Like lowdb but zero dependencies. Reads/writes a JSON file.
 * Agent definitions and conversations are persisted here.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const DB_PATH = new URL("./db.json", import.meta.url).pathname;

// ── Schema ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AgentRecord
 * @property {string} id
 * @property {string} name
 * @property {string} prompt
 * @property {string} [model]
 * @property {string} [voice]
 * @property {string} [language]
 * @property {string} [greeting]
 * @property {string[]} channels
 * @property {string} createdAt
 */

/**
 * @typedef {Object} ConversationRecord
 * @property {string} id
 * @property {string} agentId
 * @property {string} from
 * @property {string} transport
 * @property {{role: string, content: string}[]} transcript
 * @property {number} duration
 * @property {string} startedAt
 * @property {string} endedAt
 */

/**
 * @typedef {Object} DB
 * @property {AgentRecord[]} agents
 * @property {ConversationRecord[]} conversations
 */

// ── Read/Write ───────────────────────────────────────────────────────────

/** @returns {DB} */
export function readDB() {
  if (!existsSync(DB_PATH)) {
    return { agents: [], conversations: [] };
  }
  return JSON.parse(readFileSync(DB_PATH, "utf-8"));
}

/** @param {DB} data */
export function writeDB(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── Agent CRUD ───────────────────────────────────────────────────────────

/** @returns {AgentRecord[]} */
export function listAgents() {
  return readDB().agents;
}

/** @param {string} id @returns {AgentRecord|undefined} */
export function getAgent(id) {
  return readDB().agents.find((a) => a.id === id);
}

/** @param {AgentRecord} agent */
export function createAgent(agent) {
  const db = readDB();
  agent.createdAt = new Date().toISOString();
  db.agents.push(agent);
  writeDB(db);
  return agent;
}

/** @param {string} id @param {Partial<AgentRecord>} updates */
export function updateAgent(id, updates) {
  const db = readDB();
  const idx = db.agents.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  db.agents[idx] = { ...db.agents[idx], ...updates };
  writeDB(db);
  return db.agents[idx];
}

/** @param {string} id */
export function deleteAgent(id) {
  const db = readDB();
  const idx = db.agents.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  db.agents.splice(idx, 1);
  writeDB(db);
  return true;
}

// ── Conversations ────────────────────────────────────────────────────────

/** @param {ConversationRecord} conversation */
export function saveConversation(conversation) {
  const db = readDB();
  db.conversations.push(conversation);
  // Keep only last 100 conversations
  if (db.conversations.length > 100) {
    db.conversations = db.conversations.slice(-100);
  }
  writeDB(db);
}

/** @param {string} [agentId] @returns {ConversationRecord[]} */
export function listConversations(agentId) {
  const db = readDB();
  const convos = agentId
    ? db.conversations.filter((c) => c.agentId === agentId)
    : db.conversations;
  return convos.slice(-50).reverse();
}
