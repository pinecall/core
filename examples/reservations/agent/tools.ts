/**
 * Reservations Agent — Tools
 *
 * Three tools for the restaurant booking lifecycle:
 *   1. checkAvailability — open slots for date + party size
 *   2. makeReservation   — confirm a booking
 *   3. cancelReservation — cancel by ID
 */

import { tool } from "@pinecall/sdk";
import { z } from "zod";

// ── Mock state ───────────────────────────────────────────────────────────

const reservations = new Map<string, {
  id: string;
  name: string;
  date: string;
  time: string;
  partySize: number;
  table: string;
  specialRequests?: string;
}>();

// ── Tools ────────────────────────────────────────────────────────────────

export const checkAvailability = tool({
  name: "checkAvailability",
  description:
    "Check table availability for a given date, time, and party size. " +
    "Call this BEFORE offering the caller any time — never guess availability.",
  schema: z.object({
    date: z.string().describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Time in HH:MM format (24h)"),
    partySize: z.number().describe("Number of guests"),
  }),
  execute: async ({ date, time, partySize }) => {
    const hour = parseInt(time.split(":")[0]!);
    const isWeekend = new Date(date).getDay() % 6 === 0;

    if (partySize > 8) {
      return {
        available: false,
        reason: "Maximum party size is 8 guests",
        suggestion: "For larger groups, please email events@pines.com",
      };
    }

    if (hour < 11 || hour > 22) {
      return {
        available: false,
        reason: "We are open from 11:00 to 22:00",
        nextAvailable: hour < 11 ? "11:00" : "11:00 next day",
      };
    }

    if (isWeekend && hour >= 18 && hour <= 21 && partySize > 4) {
      return {
        available: false,
        reason: "Weekend dinner is fully booked for large parties",
        nextAvailable: "22:00 or try a weekday",
      };
    }

    const table = partySize <= 2 ? "window seat"
               : partySize <= 4 ? "garden terrace"
               : "private dining";

    return {
      available: true,
      table,
      estimatedDuration: partySize <= 4 ? "1.5 hours" : "2 hours",
      confirmBy: "24 hours in advance",
    };
  },
});

export const makeReservation = tool({
  name: "makeReservation",
  description:
    "Confirm and create a restaurant reservation. " +
    "ONLY call after the caller has explicitly confirmed the booking.",
  schema: z.object({
    name: z.string().describe("Guest name for the reservation"),
    date: z.string().describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Time in HH:MM format (24h)"),
    partySize: z.number().describe("Number of guests"),
    specialRequests: z.string().optional().describe("Dietary restrictions, seating preferences, celebrations"),
  }),
  execute: async ({ name, date, time, partySize, specialRequests }) => {
    const id = `RES-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const table = partySize <= 2 ? "window seat"
               : partySize <= 4 ? "garden terrace"
               : "private dining";

    reservations.set(id, { id, name, date, time, partySize, table, specialRequests });

    return { confirmed: true, reservationId: id, name, date, time, partySize, table };
  },
});

export const cancelReservation = tool({
  name: "cancelReservation",
  description:
    "Cancel an existing reservation by its ID. " +
    "ONLY call after the caller explicitly confirms they want to cancel.",
  schema: z.object({
    reservationId: z.string().describe("Reservation ID (e.g. RES-ABC123)"),
  }),
  execute: async ({ reservationId }) => {
    const existing = reservations.get(reservationId);
    if (!existing) {
      return { cancelled: false, reason: "Reservation not found" };
    }
    reservations.delete(reservationId);
    return {
      cancelled: true,
      reservationId,
      was: `${existing.name}, ${existing.date} at ${existing.time}`,
      refundPolicy: "Full refund — cancelled more than 24h in advance",
    };
  },
});

export const tools = [checkAvailability, makeReservation, cancelReservation];
