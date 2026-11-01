#!/usr/bin/env bash
# Records each user prompt verbatim as a numbered file in docs/prompts.
# Context injected by the IDE is removed, and a resend that completes the previous
# prompt replaces it, so replaying the files sends each prompt once and in full.
set -euo pipefail

dir="${CLAUDE_PROJECT_DIR:-$PWD}/docs/prompts"
resend_window_minutes=10
mkdir -p "$dir"

prompt=$(jq -r '
  (.prompt // "")
  | if startswith("<task-notification>") then "" else . end
  | reduce ("ide_opened_file", "ide_selection", "browser_instruction") as $tag
      (.; gsub("<\($tag)>[\\s\\S]*?</\($tag)>"; ""))
  | sub("^\\s+"; "")
')
[ -n "$prompt" ] || exit 0

last_file=$(ls "$dir" | grep -E '^[0-9]{4}-' | sort | tail -n 1 || true)
number=$(printf '%04d' $((10#${last_file:0:4} + 1)))
file="$dir/$number-$(date +%Y%m%d-%H%M%S).md"

if [ -n "$last_file" ] && [ -n "$(find "$dir/$last_file" -mmin "-$resend_window_minutes")" ]; then
  previous=$(sed '1,5d;$d' "$dir/$last_file")
  if [ -n "$previous" ] && [[ "$prompt" == "$previous"* ]]; then
    number=${last_file:0:4}
    file="$dir/$last_file"
  fi
fi

# The fence must outgrow any backtick run in the prompt, or Markdown would end the block early.
longest_run=$(printf '%s' "$prompt" | awk '{
  while (match($0, /`+/)) { if (RLENGTH > max) max = RLENGTH; $0 = substr($0, RSTART + RLENGTH) }
} END { print max + 0 }')
fence_size=$((longest_run < 4 ? 4 : longest_run + 1))
fence=$(printf '`%.0s' $(seq 1 "$fence_size"))

printf '# Prompt %s\n\nDate: %s\n\n%stext\n%s\n%s\n' \
  "$number" "$(date '+%Y-%m-%d %H:%M:%S %z')" "$fence" "$prompt" "$fence" \
  > "$file"
