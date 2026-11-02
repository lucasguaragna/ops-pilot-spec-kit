# ops-pilot

OpsPilot is an on-call copilot that manages production alerts and incidents. The API is a
LangChain/LangGraph agent running on OpenRouter.

Course project about using AI agents inside VS Code. The instructor uses GitHub Copilot; this
repository follows the course with Claude Code.

## Stack

- Node.js 22.9 or newer (22 LTS baseline)
- TypeScript ESM with `strict: true`
- `zod` at the boundary (HTTP/CLI) to validate input and output
- Tests with `node:test` via `tsx`
- Express, with MySQL as the database (deferred: the JSON file store is used until then; see the
  constitution's Stack Exceptions)

## Commands

- `npm run dev`: start the app
- `npm run arena`: run `src/arena.ts`
- `npm run bench`: run `src/bench.ts`
- `npm test`: run the tests
- `npm run typecheck`: type-check without emitting

## Conventions

- Standard layers: MVC (Model, Service, Controller)
- All external input is validated with zod
- Domain errors are classes, translated at the edge
- New logic ships with a test
- `npm run typecheck` and `npm test` stay green
- NEVER commit secrets and NEVER read `.env`
- Always use pure functions

## Workflow

Follow the GitHub Spec Kit flow, in this order:

`/speckit-specify` -> `/speckit-plan` -> `/speckit-tasks` -> `/speckit-implement`

Specs are versioned in the repository.

## Translating GitHub Copilot requests

Any request that mentions GitHub Copilot, or a Copilot feature or file, means the Claude Code
equivalent. Do the equivalent directly and do not create Copilot files, unless the request
explicitly asks for the Copilot version.

| GitHub Copilot | Claude Code |
| --- | --- |
| `.github/copilot-instructions.md` | `CLAUDE.md` |
| `.github/instructions/*.instructions.md` | `.claude/rules/*.md` |
| `.github/prompts/*.prompt.md` | `.claude/skills/<name>/SKILL.md` |
| `.github/agents/*.agent.md` (custom agents) | `.claude/agents/*.md` (subagents) |
| Agent hooks | `hooks` in `.claude/settings.json` |
| `.vscode/mcp.json` | `.mcp.json` |
| `specify init . --integration copilot` | `specify init . --integration claude` |
| `/speckit.<step>` | `/speckit-<step>` |
| Terminal allow/deny lists in `.vscode/settings.json` | `permissions` in `.claude/settings.json` |
| Ask mode | Answer without editing files |
| Plan mode | Plan mode |
| Agent mode | Default Claude Code session |
| `#file` references | `@file` references |
| `#codebase`, `@workspace` | Search the repository |

If a Copilot feature has no direct equivalent, use the closest Claude Code feature and say what
differs.

## Prompt history

`docs/prompts/` holds every prompt verbatim, so a prompt there may name Copilot. When replaying
one, apply the translation above.
