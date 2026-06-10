```text
██████╗ ██████╗  ██████╗ ███╗   ███╗██████╗ ████████╗██╗████████╗
██╔══██╗██╔══██╗██╔═══██╗████╗ ████║██╔══██╗╚══██╔══╝██║╚══██╔══╝
██████╔╝██████╔╝██║   ██║██╔████╔██║██████╔╝   ██║   ██║   ██║
██╔═══╝ ██╔══██╗██║   ██║██║╚██╔╝██║██╔═══╝    ██║   ██║   ██║
██║     ██║  ██║╚██████╔╝██║ ╚═╝ ██║██║        ██║   ██║   ██║
╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝        ╚═╝   ╚═╝   ╚═╝
```

# PromptIT MCP Server

PromptIT is a local-first MCP safety preflight for AI coding agents. It checks a user request against live repo state before the agent starts risky work, then returns `skip`, `allow`, `warn`, `needs_confirmation`, or `block`.

PromptIT is not a prompt cleaner. It is a repo-aware risk gate for dangerous coding workflows.

## Why MCP?

PromptIT needs MCP because it is not just advice written in a file. It needs to inspect live repo state, read git status, detect changed migration/auth/deploy/dependency files, scan diffs for secret-looking values, and return a structured decision that the host can enforce before the agent acts.

That makes it a tool, not only an instruction. MCP gives PromptIT a callable boundary where the host can ask, "Is this request safe to execute right now in this repo?" and receive a machine-readable answer like `allow`, `warn`, `needs_confirmation`, or `block`.

## Why Not Just SKILL.md?

A `SKILL.md` file is useful for teaching an agent how to behave, but it is still mostly guidance. It can say "be careful with migrations" or "check for secrets," but it cannot reliably inspect the current repository, count dirty files, detect the active branch, or produce a consistent policy decision on its own.

PromptIT and `SKILL.md` can work together, but they solve different problems. `SKILL.md` is like a driving lesson; PromptIT is like the seat belt and warning system that checks the actual car before you start moving.

## Why Choose PromptIT?

People should choose PromptIT when they want AI coding agents to move fast without blindly touching dangerous parts of a codebase. It is especially useful for teams or solo developers who let agents edit, test, commit, push, deploy, modify dependencies, or change database/auth/security code.

The seat belt example is the simplest way to think about it: a good driver still wears a seat belt, not because they are bad at driving, but because one mistake can be expensive. Modern coding agents are strong, but PromptIT adds a safety layer for the moments where one wrong action can leak a secret, break production, damage a schema, or push risky changes from the wrong branch.

## What It Catches

- Database migrations and schema changes
- Auth, session, cookie, token, and permission changes
- Push, deploy, release, and production-sensitive requests
- Dependency upgrades and lockfile changes
- Large refactors
- Secret-looking values in diffs
- Infrastructure and CI/deploy config changes

## Policy Structure

Runtime policies live in `src/policies/` as typed source modules. Each risk area has its own file, and `src/policies/index.ts` exports the combined policy map used by `src/preflight.ts`.

```text
src/policies/
  auth.ts
  database.ts
  dependencies.ts
  deploy.ts
  infrastructure.ts
  normalCoding.ts
  refactor.ts
  safeSimple.ts
  secrets.ts
  types.ts
```

PromptIT does not use Markdown policy files for enforcement. Markdown is only documentation; the executable safety decisions stay in typed code so they can be tested and kept deterministic.

To change an existing policy, edit the matching file in `src/policies/` and update the tests that cover the expected decision. To add a new risk type, add it to `src/policies/types.ts`, create a new policy file, export it from `src/policies/index.ts`, and update the classifier in `src/preflight.ts`.

Each policy controls:

- `riskType`: the stable machine-readable risk id.
- `severity`: `low`, `medium`, `high`, or `critical`.
- `decision`: `skip`, `allow`, `warn`, `needs_confirmation`, or `block`.
- `requiredChecks`: the checks the host should follow before risky work.
- `blockedWhen`: optional hard-stop logic based on live repo facts.

## Project Structure

```text
src/server.ts       # MCP stdio server and tool registration
src/preflight.ts    # repo inspection, risk classification, response building
src/policies/       # executable policy definitions
src/cli.ts          # one-command host installer and generated instructions
src/config.ts       # small runtime constants
tests/              # behavior and policy-registry tests
```

There is no prompt-refiner layer, no prompts.chat ingestion, no database module, and no `PROMPTENGINEER.md`. PromptIT is intentionally a narrow safety preflight tool.

## Runtime Flow

```text
User request
   |
Host LLM silently suggests risk_type + confidence
   |
Host calls preflight_request
   |
PromptIT inspects request + repo
   |
PromptIT combines host signal + local repo signals
   |
Hard policies make the final decision
   |
safe/normal -> skip or allow
risky      -> warn, needs_confirmation, or block
   |
Host follows decision before editing
```

The host LLM can help interpret vague language like "ship this" or "make it live", but it cannot override hard PromptIT rules. For example, secret-looking diffs still `block`, and database migrations on `main` or `master` still `block`.

Example response:

```json
{
  "protocol": "promptit.preflight.v1",
  "decision": "needs_confirmation",
  "risk_type": "database_migration",
  "local_risk_type": "database_migration",
  "host_classification": null,
  "severity": "high",
  "evidence": [
    "classified request as database_migration",
    "current branch: main",
    "migration files changed"
  ],
  "required_checks": [
    "inspect existing migration history",
    "confirm rollback or reversible migration plan",
    "run migration/database tests if available",
    "do not push until user confirms migration safety"
  ],
  "host_instruction": "..."
}
```

## MCP Tools

- `preflight_request`: classify risk, inspect repo state, and return a safety decision.

The runtime MCP surface intentionally does not expose prompt rewriting tools.

Tool input:

```json
{
  "request": "ship this today",
  "repo_path": "/absolute/path/to/repo",
  "host_classification": {
    "risk_type": "production_deploy",
    "confidence": 0.86,
    "summary": "The phrase ship this likely means release or deploy work."
  }
}
```

`repo_path` and `host_classification` are optional. If the host cannot pass `repo_path`, PromptIT falls back to `PROMPTIT_TARGET_REPO` and then the current working directory.

## Repo Facts Inspected

- Git branch
- Dirty/staged files
- Changed file paths
- Package manager
- Test/build/check scripts
- CI config presence
- Migration/auth/deploy/dependency file changes
- Secret-looking strings in tracked diffs

PromptIT does not return raw diff contents.

## Data Policy

PromptIT is stateless by default. It does not use a database and does not store raw prompts, generated prompts, file contents, diffs, repo facts, decisions, outcomes, or secrets.

Secret scanning only counts secret-looking matches in tracked git diffs. PromptIT never returns the matched secret text.

## Quick Start

```bash
bun install
bun run promptit -- setup
bun run start
```

For a specific host:

```bash
promptit --codex
promptit --claude
promptit --host cursor --print-config
```

If the binary is not linked globally:

```bash
bun run promptit -- --codex
```

## Host Policy

Generated host instructions tell the agent:

1. Silently classify the request into a likely PromptIT `risk_type` with confidence and a short summary.
2. Call `prompt_it.preflight_request` before any non-tiny coding request.
3. Pass the active workspace path as `repo_path` when available.
4. Pass the host classification as `host_classification`.
5. Proceed normally for `skip` or `allow`.
6. Apply `host_instruction` for `warn`.
7. Ask for confirmation for `needs_confirmation`.
8. Stop for `block`.

PromptIT should stay silent for ordinary low-risk coding tasks.

## Development

```bash
bun test
./node_modules/.bin/tsc --noEmit
npm run build
```
