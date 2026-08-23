# Outbound dispatch — a list of people to ring

Inbound is one call at a time. Outbound is a list, and a list needs a pace, a
memory of who has already been rung, and somewhere to put the answer.
`DispatchHub` is that machine: it watches a source, places calls within the
limits you give it, and never rings the same row twice.

The source here is a CSV, and it is both the queue and the result:

```
data/leads.csv
  row with no status ──▶ a call goes out (5/min, 2 at a time)
        │
        ├─ contact answers ──▶ confirm_appointment tool ──▶ status = confirmed | cancelled | reschedule
        └─ nobody answers  ──▶ onCompleted / onFailed   ──▶ status = the end reason
                                                              │
  row with a status ──────────────────────────────────────────┴──▶ skipped forever
```

That last arrow is the important one: restarting the process is harmless, and
adding a row while it runs sends a call on the next poll.

**This example dials real phone numbers.** Put your own in the CSV before you
run it — the seeded rows are placeholders and will fail.

## Run it

```bash
npm install
cp .env.example .env    # then fill in PINECALL_API_KEY and PHONE
# edit data/leads.csv — real numbers, empty status column
npm start
```

| env | what |
|---|---|
| `PINECALL_API_KEY` | your key |
| `AGENT` | the slug to register as (default `outbound-dispatch`) |
| `PHONE` | the number to call **from** (E.164) — required |
| `LEADS` | path to the CSV (default `./data/leads.csv`) |

## What you will see

`Agent 'outbound-dispatch' ready — dialling from +1…`, then a line per call as
the hub paces itself: `Calling +1… — Ada`, the answer when the tool fires
(`Answer from Ada (Dentist): confirmed`), the write-back
(`+1… (Dentist) → confirmed`) and the end reason. Open `data/leads.csv`
afterwards — every row has a status, and a second `npm start` places no calls
at all.
