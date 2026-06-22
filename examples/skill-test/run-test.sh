#!/usr/bin/env bash
# Skill demo — start the agent, run the test specs, then tear down.
#
# Usage:
#   PINECALL_API_KEY=pk_…  ANTHROPIC_API_KEY=sk-…  ./run-test.sh
#
# Needs:
#   - PINECALL_API_KEY : an API key for a paid org with managed LLM (server-side
#                        LLM is required for skills).
#   - ANTHROPIC_API_KEY: the test judge (Claude Haiku) runs locally.
set -euo pipefail
cd "$(dirname "$0")"

: "${PINECALL_API_KEY:?set PINECALL_API_KEY to a key for your Pinecall org}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY for the test judge}"

CLI="node ../../dist/cli.js"     # local CLI build (has the latest SDK)
LOG="$(mktemp)"

echo "▶ starting agent 'skilltest'…"
$CLI run agent.ts >"$LOG" 2>&1 &
AGENT_PID=$!
trap 'kill "$AGENT_PID" 2>/dev/null || true; rm -f "$LOG"' EXIT

# Wait for the agent to register (or fail).
for i in $(seq 1 30); do
  if grep -q "registered — skills" "$LOG"; then echo "✓ agent up"; break; fi
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then echo "✗ agent exited early:"; cat "$LOG"; exit 1; fi
  sleep 1
done

echo "▶ running specs…"
$CLI test . --judge anthropic:claude-haiku-4-5-20251001

echo
echo "── agent log (skill events) ─────────────────────────────"
grep -E "skill\.(loaded|unloaded)|🔧" "$LOG" || echo "(no skill events captured in agent log)"
