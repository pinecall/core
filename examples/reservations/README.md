# Reservations — three tools in a fixed order

[`../tools`](../tools) shows one tool. This shows what changes when there are
three and the order matters: check availability *before* offering a time, book
*only* after the caller confirms, cancel *only* when they ask. The model never
invents a free table — every "yes, 8pm works" came out of `checkAvailability`.

```
"a table for four on Friday?"
   └─▶ checkAvailability(date, time, 4)  ──┬─ { available: false, reason, nextAvailable }
                                           │      └─▶ the agent offers the alternative
                                           └─ { available: true, table }
                                                  └─▶ caller confirms
                                                       └─▶ makeReservation(...) ──▶ RES-XXXXXX
```

Note the shape of a refusal: `{ available: false, reason, suggestion }`, not
`false`. The model reads `reason` out loud and turns `suggestion` into the next
thing it offers — a tool that only says no makes an agent that only says no.

Bookings live in a `Map` and die with the process. That is on purpose: this
file is about the choreography, not storage.

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `reservations`) |
| `PHONE` | a number in your org to answer on (E.164). Empty → browser only |

## What you will see

`Agent 'reservations' ready`, then one line per tool that fires — `booked
RES-4F2A1C — Ana, 2026-09-04 20:00, 4 guests` — and the booking count when the
call ends. Ask for a table for ten, or for 3am, and watch the agent relay the
tool's `reason` instead of apologising in its own words.

## The full restaurant

This is one file showing tool choreography. The complete two-process
restaurant app — a real database, a dashboard, deploys — is `bistro` in
[`pinecall/examples`](https://github.com/pinecall/examples).
