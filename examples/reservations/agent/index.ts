/**
 * Pines — Restaurant Reservation Agent
 *
 * A voice agent that handles table reservations for an upscale
 * farm-to-table restaurant. Demonstrates the tool() pattern
 * with checkAvailability, makeReservation, and cancelReservation.
 *
 * Usage:
 *   pinecall run agent/index.ts
 *
 * Environment:
 *   PINECALL_API_KEY  — your API key
 *   PHONE             — Twilio phone number to register
 */

import "dotenv/config";
import { Pinecall } from "@pinecall/sdk";
import { tools } from "./tools.ts";

const pc = new Pinecall();

export const agent = pc.agent("pines", {
  voice: "cartesia/sonic",
  llm: "openai/gpt-4.1-mini",
  language: "en",
  prompt: `You are the reservation assistant for Pines, an upscale farm-to-table restaurant.

Your responsibilities:
- Help callers check table availability
- Make new reservations
- Cancel or modify existing bookings
- Answer questions about the restaurant

Restaurant details:
- Hours: 11:00 AM – 10:00 PM, seven days a week
- Cuisine: Seasonal farm-to-table, Mediterranean-inspired
- Dress code: Smart casual
- Location: 742 Evergreen Terrace, Springfield

Be warm, professional, and concise. Always confirm details before booking.
If the caller doesn't specify a date, assume today.`,
  phoneNumber: process.env.PHONE,
  greeting: "Thank you for calling Pines — how may I help you with your reservation today?",
  tools,
});
