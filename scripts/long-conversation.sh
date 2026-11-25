#!/usr/bin/env bash
# Sends a fixed series of on-call messages to a running OpsPilot server, all in one conversation,
# and prints one line per turn: the real promptTokens the provider reported, and the estimated
# history size. Watch the history climb to 14 messages and drop to 8 on turn 9, when it is summarized.
#
#   scripts/long-conversation.sh
#   OPSPILOT_URL=http://127.0.0.1:3001 TURNS=14 scripts/long-conversation.sh
#
# OPSPILOT_URL  server base URL (default http://127.0.0.1:3000)
# TURNS         number of turns, a positive integer (default 10)
#
# Exit status: 0 when every turn was sent (even if some failed), 1 when the server cannot be
# reached, 2 for a bad TURNS or a missing tool. Needs bash, curl, and jq.

set -u

BASE_URL="${OPSPILOT_URL:-http://127.0.0.1:3000}"
BASE_URL="${BASE_URL%/}"
TURNS="${TURNS:-10}"

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required" >&2
    exit 2
  fi
done

if [[ ! "$TURNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "TURNS must be a positive integer" >&2
  exit 2
fi

MESSAGES=(
  "Which alerts are firing right now?"
  "I am on the payments team."
  "Which of those alerts belong to my team?"
  "Open an incident for the most severe one."
  "What is the status of that incident?"
  "Are there any critical incidents still open?"
  "Which service has the most alerts?"
  "Summarize what we have discussed so far."
  "Resolve the incident we just opened."
  "Which alerts are still firing after that?"
  "Is checkout-api healthy right now?"
  "Give me a one-line status for the on-call handoff."
)

conversation_id=""

for ((turn = 1; turn <= TURNS; turn++)); do
  message="${MESSAGES[$(((turn - 1) % ${#MESSAGES[@]}))]}"
  body="$(jq -n --arg message "$message" --arg id "$conversation_id" \
    '{message: $message, strategy: "react", reflect: false} + (if $id == "" then {} else {conversationId: $id} end)')"

  # The last line of the output is the HTTP status; everything before it is the body.
  if ! response="$(curl -sS --max-time 300 -H 'content-type: application/json' -d "$body" \
    -w $'\n%{http_code}' "$BASE_URL/chat" 2>/dev/null)"; then
    echo "Cannot reach $BASE_URL" >&2
    exit 1
  fi
  status="${response##*$'\n'}"
  payload="${response%$'\n'*}"

  # Every reply that names a conversation (200, 502, 504) keeps the later turns in it.
  if [[ -z "$conversation_id" ]]; then
    conversation_id="$(jq -r '.conversationId // empty' <<<"$payload" 2>/dev/null || true)"
  fi

  if [[ "$status" == "200" ]]; then
    jq -r --argjson turn "$turn" \
      '"turn \($turn) | promptTokens \(.metrics.promptTokens // "n/a") | history \(.metrics.contextBreakdown.history) (\(.metrics.historyMessages) messages)"' \
      <<<"$payload"
  else
    code="$(jq -r '.error // empty' <<<"$payload" 2>/dev/null || true)"
    echo "turn $turn | error ${code:-http_$status}"
  fi
done
