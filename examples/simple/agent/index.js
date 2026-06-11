/**
 * Simple Agent — A minimal voice agent with call history.
 *
 * Usage:
 *   pinecall run agent/index.js
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — Twilio phone number to register
 */

import "dotenv/config";
import { Pinecall, JsonFileHistory } from "@pinecall/sdk";

const pc = new Pinecall();

export const agent = pc.agent("simple-agent", {
  voice: "elevenlabs/sarah",
  language: "en",
  stt: "deepgram/flux",
  llm: "openai/gpt-4.1-mini",
  prompt:
    "You are a friendly assistant. Keep your responses short (1-2 sentences) since this is a voice call.",
  phoneNumber: process.env.PHONE,
  greeting: "Hello! How can I help you today?",
  history: new JsonFileHistory("./data/calls.json"),
});
