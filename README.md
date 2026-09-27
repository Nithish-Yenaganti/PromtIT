# PromptIT MCP Server

PromptIT is a local-first MCP safety preflight for AI coding agents. It checks a user request against live repo state before the agent starts risky work, then returns `skip`, `allow`, `warn`, `needs_confirmation`, or `block`.

PromptIT is not a prompt cleaner. It is a repo-aware risk gate for dangerous coding workflows.

## Quick Start

Requires Git and Bun. The repository's CI uses Bun **1.3.12**. Start from a source checkout:

```sh
git clone https://github.com/Nithish-Yenaganti/PromtIT.git
cd PromtIT
bun install --frozen-lockfile
bun run promptit -- --help
bun run promptit -- --host my-host --print-config
```

The last command prints an MCP configuration and host instructions without changing your host settings. Add the configuration and instructions to your MCP client, then restart the client. The generated paths point to this checkout, so keep it in a stable location.

From your MCP client, call `preflight_request` with an absolute path to the repository you want to inspect:

```json
{
  "request": "add a database migration",
  "repo_path": "/absolute/path/to/your/repository"
}
```

On a repository with a commit checked out on `main` or `master`, expect `decision: "block"` and a branch-specific reason in `evidence`. On a feature branch, a migration normally returns `needs_confirmation`; other repository signals can raise the risk further.

The client launches the stdio server. If you run `bun run start` yourself, the process waits for MCP messages; it does not open a web page.

### Optional host installers

Preview a host-specific configuration first:

```sh
bun run promptit -- --codex --print-config
bun run promptit -- --claude --print-config
```

These commands apply it and create a backup of an existing host configuration:

```sh
bun run promptit -- setup --codex
# Or, for Claude Desktop on macOS:
bun run promptit -- setup --claude
```

Restart the selected host after installation. `bun run promptit -- doctor` reports the runtime, server file, and host configuration presence; it is not an end-to-end connection test.

## Enforcement and Limitations

PromptIT returns a policy decision. It does not intercept shell commands, revoke permissions, or prevent an agent from bypassing the tool. The host must call it before acting and honor the response. Changes after a preflight require a fresh check.

Classification uses request text, local repository signals, and an optional host classification. It can miss risks or flag harmless changes. Secret detection is pattern-based and currently scans the **unstaged tracked diff**; staged-only changes, untracked file contents, and committed history are not scanned for secret values. An `allow` response is not a security audit.

## Why MCP?

MCP lets the host request a structured decision based on live repository state, rather than relying only on written guidance. Instructions can tell an agent to inspect Git state; PromptIT implements repeatable checks and returns evidence the host can act on. Use it alongside the host's permissions, tests, and review process.

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

Example response excerpt for a migration on `main` (additional repository facts and host instructions omitted):

```json
{
  "protocol": "promptit.preflight.v1",
  "decision": "block",
  "risk_type": "database_migration",
  "local_risk_type": "database_migration",
  "host_classification": null,
  "severity": "high",
  "evidence": [
    "database migration risk detected on main/master branch",
    "classified request as database_migration",
    "current branch: main"
  ],
  "required_checks": [
    "inspect existing migration history",
    "confirm rollback or reversible migration plan",
    "run migration/database tests if available",
    "do not push until user confirms migration safety"
  ]
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
- Secret-looking strings in the unstaged tracked diff

PromptIT does not return raw diff contents.

## Data Policy

PromptIT is stateless by default. It does not use a database and does not store raw prompts, generated prompts, file contents, diffs, repo facts, decisions, outcomes, or secrets.

Secret scanning only counts secret-looking matches in the unstaged tracked Git diff. PromptIT never returns the matched secret text.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and the information to include in a bug report or pull request.

## License

[MIT](LICENSE).
