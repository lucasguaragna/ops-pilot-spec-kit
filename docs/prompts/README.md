# Prompt history

Every prompt sent to Claude Code in this project, verbatim and in order. To replicate the
project, start from an empty folder and send each numbered file's prompt in sequence.

Files are created by the `UserPromptSubmit` hook in `.claude/settings.json`, which runs
`.claude/hooks/log-prompt.sh`. Numbers are sequential; the date in the file name and body
records when the prompt was sent.

Each file holds what the user typed. Context injected by the IDE (open file, selection, browser
instructions) is left out. A prompt sent again within 10 minutes that starts with the previous
prompt's full text replaces it, so an interrupted, partial send does not become its own step.

Prompts are committed as written, so never paste secrets into one.
