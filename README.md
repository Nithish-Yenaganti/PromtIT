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

## What It Catches

- Database migrations and schema changes
- Auth, session, cookie, token, and permission changes
- Push, deploy, release, and production-sensitive requests
- Dependency upgrades and lockfile changes
- Large refactors
- Secret-looking values in diffs
- Infrastructure and CI/deploy config changes

## Runtime Flow

```text
User request
   |
Host silently calls preflight_request
   |
PromptIT inspects request + repo
   |
safe/normal -> skip or allow
risky      -> warn, needs_confirmation, or block
   |
Host follows decision before editing
```

Example response:

```json
{
  "protocol": "promptit.preflight.v1",
  "decision": "needs_confirmation",
  "risk_type": "database_migration",
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
- `record_preflight_outcome`: record aggregate outcome stats without storing prompts, diffs, or file contents.

The runtime MCP surface intentionally does not expose prompt rewriting tools.

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

PromptIT stores only aggregate preflight stats:

- risk type
- decision
- outcome
- count
- last used time

PromptIT does not store raw prompts, generated prompts, file contents, diffs, or secrets.

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

1. Call `prompt_it.preflight_request` before risky coding work.
2. Pass the active workspace path as `repo_path` when available.
3. Proceed normally for `skip` or `allow`.
4. Apply `host_instruction` for `warn`.
5. Ask for confirmation for `needs_confirmation`.
6. Stop for `block`.
7. Optionally call `record_preflight_outcome` after the task.

PromptIT should stay silent for ordinary low-risk coding tasks.

## Development

```bash
bun test
./node_modules/.bin/tsc --noEmit
npm run build
```
