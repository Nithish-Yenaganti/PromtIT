```text
██████╗ ██████╗  ██████╗ ███╗   ███╗██████╗ ████████╗██╗████████╗
██╔══██╗██╔══██╗██╔═══██╗████╗ ████║██╔══██╗╚══██╔══╝██║╚══██╔══╝
██████╔╝██████╔╝██║   ██║██╔████╔██║██████╔╝   ██║   ██║   ██║
██╔═══╝ ██╔══██╗██║   ██║██║╚██╔╝██║██╔═══╝    ██║   ██║   ██║
██║     ██║  ██║╚██████╔╝██║ ╚═╝ ██║██║        ██║   ██║   ██║
╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝        ╚═╝   ╚═╝   ╚═╝
```


[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
# PromptIT MCP Server


PromptIT is a local-first Model Context Protocol (MCP) server that turns messy user requests into reviewable prompt payloads using prompts.chat-style templates. It stays a tool layer, not an app: the MCP host owns the UI, the host LLM performs the actual rewrite, and PromptIT coordinates template selection, review state, and lightweight template stats.

## Core Logic

PromptIT no longer runs embedding models and no longer stores raw prompt history in the core path. The runtime is now:

1. Template Routing: classify the messy request with deterministic keyword/tag rules.
2. Template Selection: choose the best cached prompts.chat-style template using intent, tags, quality score, and aggregate stats.
3. Host LLM Payload: return the messy request plus selected template instructions so the host LLM can generate the refined prompt.
4. Review Protocol: return `promptit.review.v1` payloads for edit, regenerate, and send/execute.
5. Minimal Learning: store only template-level counters such as selected, edited, regenerated, accepted, rejected, and executed counts.

## System Architecture

The project is divided into five small modules:

* `src/server.ts`: MCP server setup, stdio transport, and tool registration.
* `src/database.ts`: SQLite template cache and aggregate template stats.
* `src/templates.ts`: deterministic template ranking and event scoring.
* `src/refiner.ts`: PromptIT review protocol for normalize, regenerate, and commit.
* `src/config.ts`: DB paths, token limits, and runtime thresholds.

## Project Structure

```text
promptit-mcp/
├── src/
│   ├── server.ts      # Core MCP server setup and tool registration
│   ├── database.ts    # SQLite template cache and aggregate stats
│   ├── templates.ts   # Template routing and ranking
│   ├── refiner.ts     # Review protocol and host-LLM payload orchestration
│   └── config.ts      # DB paths, limits, thresholds
├── scripts/
│   ├── render-codex-config.sh
│   └── fetch-prompts-chat-engineering.ts
├── config.example.toml
├── PROMPTENGINEER.md
├── package.json       # Bun/TypeScript dependencies and scripts
└── README.md
```

## Why MCP?

MCP gives PromptIT a clean tool boundary. The server can select templates, return structured review payloads, and update template stats while the host app renders the review screen and sends the final prompt to the actual agent.

## Quick Start

```bash
bun install
bun run promptit -- --codex --preset developer
bun run start
```

## MCP Host Setup

PromptIT ships as a stdio MCP server. After installing dependencies, use the `promptit` installer command for your MCP host:

```bash
promptit --codex --preset developer
promptit --claude --categories coding,technical-writing
promptit --cursor --preset writer
promptit --host my-host --print-config
```

`promptit --codex` updates `~/.codex/config.toml` with a managed PromptIT block. `promptit --claude` updates Claude Desktop's `claude_desktop_config.json`. Unknown hosts write a generic `promptit.<host>.mcp.json` file in this repo.

PromptIT does not have to load every prompts.chat category. Pick what the user needs:

```bash
promptit categories
promptit sync --preset developer --limit 1
promptit sync --categories coding,writing,business --limit 1
promptit sync --resume
promptit doctor
```

Available presets are `developer`, `writer`, `business`, `creative`, `productivity`, and `all`. Prefer a focused preset over `all` because prompts.chat rate-limits category syncs.

If you do not have the binary linked globally yet, run the same installer through Bun:

```bash
bun run promptit -- --codex --preset developer
bun run promptit -- --claude --categories coding,technical-writing
```

You can still generate a config snippet manually and add it to the host you want to use:

```bash
bash scripts/render-codex-config.sh
```

Write the rendered snippet to a local file if you want to inspect it first:

```bash
bash scripts/render-codex-config.sh --output ./promptit.codex.toml
```

The rendered config follows this shape:

```toml
[mcp_servers.prompt_it]
command = "bun"
args = ["run", "/YOUR/ABSOLUTE/PATH/src/server.ts"]
cwd = "/YOUR/ABSOLUTE/PATH"

[mcp_servers.prompt_it.env]
PROMPTIT_DB_PATH = "/YOUR/ABSOLUTE/PATH/data/promptit.db"

[agents.prompt_engineer]
description = "Specialist in converting messy user thoughts into high-fidelity expert system prompts."
mcp_servers = ["prompt_it"]
developer_instructions = """
You are the orchestration layer only.
Follow PROMPTENGINEER.md as the single source of truth for refinement policy.
For each messy request:
0. For medium/large/ambiguous tasks, do not run web search, file edits, code execution, or any other tool before normalize_prompt.
0b. Tiny mechanical tasks may skip PromptIT.
1. Call prompt_it.normalize_prompt with messy_text.
2. If status is needs_host_refinement, use conversion_context.payload to generate converted_prompt with the host LLM.
3. Call prompt_it.normalize_prompt again with task_id, execution_token, messy_text, and converted_prompt.
4. Show Converted Prompt and concise edit/regenerate/send actions.
5. Use prompt_it.regenerate_prompt when the user requests changes.
6. When approved, call prompt_it.commit_prompt with final_prompt and destination.
7. Execute/send the returned final_prompt.
"""
```

## Tool Runtime Flow

```text
[User Messy Prompt]
       |
       v
[Host App / MCP Client] -- normalize_prompt --> [PromptIT MCP Server]
       |                                             |
       |                                             v
       |                              [Template cache + template stats]
       |                                             |
       |                                             v
[Host LLM receives selected template + messy request]
       |
       v
[Host UI Plan/Review Screen] <-- promptit.review.v1 payload
       |
       +--> optional user edit
       +--> optional regenerate_prompt
       |
       v
[User Clicks Execute] -- commit_prompt --> [Template stats updated]
       |
       v
[Host sends final_prompt to main agent]
```

## Server Role

- `normalize_prompt`: select a prompts.chat-style template and return host-LLM refinement context; when called with `converted_prompt`, return the review payload.
- `regenerate_prompt`: update the review session when the user asks for a different version and increment template regeneration stats.
- `commit_prompt`: approve the current or user-edited prompt, update aggregate template stats, and return `final_prompt` for the host to send.
- `sync_prompts_chat`: fetch prompts.chat templates, normalize and validate them, then upsert valid templates into the local SQLite template cache.
- `bootstrap_prompts_chat`: seed the local cache with a small prompts.chat starter set, defaulting to 1 template per public prompts.chat category.
PromptIT does not run a generative model, does not run embeddings, does not store raw messy prompts, and does not own final delivery.

## Template Ingestion

On server startup, PromptIT starts a best-effort prompts.chat bootstrap sync in the background. It tries to import 1 template from each known public prompts.chat category; if prompts.chat is slow or rate-limited, the MCP server still starts and falls back to local/default templates.

Run `bootstrap_prompts_chat` from an MCP host, or run `bun run prompts:chat:sync -- --bootstrap --templates-per-category 1`, to manually retry setup. Run `sync_prompts_chat`, or `bun run prompts:chat:sync -- --dry-run`, to search targeted prompts.chat categories and import valid template metadata into SQLite. The sync defaults to `https://prompts.chat/api/mcp`; set `PROMPTS_API_KEY` if your prompts.chat access requires auth.

PromptIT must not call prompts.chat `improve_prompt`. prompts.chat is used for template discovery/search only; the host LLM performs refinement and PromptIT wraps that result in the review/approval flow.

PromptIT should not aggressively mirror all prompts.chat prompts. It uses light category bootstrap, stores derived routing/refinement metadata, and keeps full prompt refinement work inside the host LLM. As users approve and execute prompts, PromptIT stores category counters only; repeated usage can trigger small background syncs for that category.

For security, custom `server_url` values are rejected unless they use HTTPS and match `https://prompts.chat/api/mcp`, `PROMPTIT_ALLOWED_PROMPTS_CHAT_URLS`, or `PROMPTIT_ALLOWED_MCP_ORIGINS`.

```json
{
  "keywords": ["engineering", "review", "architecture"],
  "limit": 25,
  "dry_run": true
}
```

Manual first-run bootstrap:

```bash
bun run promptit -- sync --preset developer --limit 1
```

Manual category sync:

```bash
bun run promptit -- sync --categories coding --limit 3
```

## Review Payload Shape

```json
{
  "protocol": "promptit.review.v1",
  "status": "ready_for_review",
  "task_id": "...",
  "execution_token": "...",
  "original_prompt": "...",
  "converted_prompt": "...",
  "selected_template": {
    "id": "prompts-chat.coding-change.v1",
    "name": "Coding Change Request",
    "source": "prompts.chat",
    "score": 0.8125,
    "reasons": ["intent:coding", "matched:code,repo,build"]
  },
  "actions": ["edit", "regenerate", "send"],
  "tools": {
    "regenerate": "regenerate_prompt",
    "send": "commit_prompt"
  }
}
```

## Data Policy

PromptIT persists only template metadata and aggregate template stats by default. It does not persist raw user prompts, generated prompts, chat history, or execution logs.

## Token/Cost Visibility

`commit_prompt` returns an estimated token comparison for the in-memory messy prompt and final prompt. Optional cost estimation is enabled by setting:

```bash
PROMPTIT_INPUT_COST_PER_1K=0.005
```
