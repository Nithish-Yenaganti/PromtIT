[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
# PromptIT MCP Server

PromptIT is a local-first Model Context Protocol (MCP) server for turning messy user prompts into reviewable, approval-ready prompt payloads using persistent local memory. It is intentionally a tool layer, not a standalone application: the MCP host owns the UI, editing surface, and final send action.

## Core Logic

This server implements a Retrieval-Augmented Generation (RAG) workflow. When a user provides a raw prompt, the system does not simply pass it through. Instead, it executes the following technical sequence:

1. Semantic Fingerprinting: The server uses a local embedding model (Transformers.js) to convert the user's text into a numerical vector.
2. Memory Retrieval: It queries a local SQLite database to find historically similar prompts and their successful refinements based on vector similarity.
3. Contextual Assembly: It returns conversion context or a structured review payload that the host can render as edit/regenerate/send controls.
4. Learning Loop: By tracking structured feedback (`score`, `source`, `metadata`), the server adjusts retrieval ranking so higher-quality past refinements are prioritized.

## System Architecture

The project is divided into four functional layers:

* `src/server.ts`: Core MCP server setup, stdio transport, and tool registration.
* `src/database.ts`: SQLite connection, embedding storage, prompt history CRUD, semantic recall, and feedback writes.
* `src/refiner.ts`: PromptIT protocol orchestration for normalize, regenerate, commit, and legacy compatibility.
* `src/embeddings.ts`: Local Transformers.js embedding pipeline for semantic search.
* `src/config.ts`: DB paths, model settings, token limits, and runtime thresholds.

## Project Structure

```text
promptit-mcp/
├── src/
│   ├── server.ts       # Core MCP server setup and tool registration
│   ├── database.ts     # SQLite connection, embedding storage, history CRUD, feedback
│   ├── refiner.ts      # PromptIT review protocol and local prompt orchestration
│   ├── embeddings.ts   # Local embedding generation for semantic search
│   └── config.ts       # DB paths, local model settings, limits, thresholds
├── package.json        # Bun/TypeScript dependencies and scripts
└── README.md
```

## Why MCP?

By utilizing the Model Context Protocol instead of a standard text-based instruction set, this tool gains capabilities impossible for static files:

* Stateful Memory: It maintains a history that persists across different chat sessions and different AI agents.
* Computational Logic: It can perform embedding and similarity search outside normal context windows.
* Privacy: All data processing, including vectorization and storage, occurs on the local machine.

## Quick Start

```bash
bun install
bun run ./src/server.ts
```

## Stability Notes (Embedding Runtime)

PromptIT embeddings run locally via Transformers.js. For more stable local runtime behavior, use:

```bash
TRANSFORMERS_BACKEND=wasm
OMP_NUM_THREADS=1
ORT_NUM_THREADS=1
```

These are also defaulted automatically by `src/embeddings.ts` when not set.

## Codex Extension Setup (Stdio Mode)

Quick auto-setup (recommended):

```bash
bash scripts/setup-codex-config.sh
```

This fills your absolute project path into `~/.codex/config.toml` automatically and backs up any existing config first.

Open your global Codex config file:

- macOS/Linux: `~/.codex/config.toml`
- Windows: `%USERPROFILE%\.codex\config.toml`

Add a server + agent:

```toml
[mcp_servers.prompt_it]
command = "bun"
args = ["run", "/YOUR/ABSOLUTE/PATH/src/server.ts"]
cwd = "/YOUR/ABSOLUTE/PATH"

[agents.prompt_engineer]
description = "Specialist in converting messy user thoughts into high-fidelity expert system prompts."
mcp_servers = ["prompt_it"]
developer_instructions = """
You are a Master Prompt Engineer. When the user provides a vague request:
0. Do not run web search, file edits, code execution, or any other tools before normalize_prompt for a new non-tiny request.
1. Call prompt_it.normalize_prompt with messy_text.
2. If status is needs_host_refinement, use conversion_context.payload to rewrite into a structured expert system prompt.
3. Call prompt_it.normalize_prompt again with messy_text and converted_prompt.
4. Print Converted Prompt and concise edit/regenerate/send review actions.
5. Use prompt_it.regenerate_prompt when the user requests a different version.
6. Call prompt_it.commit_prompt with the approved final_prompt.
7. Send or execute the returned final_prompt.
"""
```

Restart the extension after saving `config.toml`.

Important: use `src/server.ts` for MCP launch (not `dist/server.js`). The bundled dist runtime can fail native ONNX module resolution in Bun on some machines.

## Claude Code Setup (Stdio Mode)

Quick auto-setup (recommended):

```bash
bash scripts/setup-claude-code-config.sh
```

Default write target is `~/.claude/mcp.json`. Override target if needed:

```bash
bash scripts/setup-claude-code-config.sh --target /path/to/claude-mcp.json
```

Or print the rendered config without writing:

```bash
bash scripts/setup-claude-code-config.sh --print
```

Template file used by the script:

- `claude-code.config.json`

It automatically replaces `/YOUR/ABSOLUTE/PATH` with your real project path and writes the rendered JSON config.

Claude-specific instruction entrypoint for this repo:

- `CLAUDE.md`

`CLAUDE.md` delegates policy to:

- `AGENTS.md` (execution contract)
- `PROMPTENGINEER.md` (refinement policy)

## Server Role (Tool-Only Prompt Approval Protocol)

This server is designed as a librarian/orchestrator backend. It does not render a web UI and does not own final delivery to a chat model. Hosts should treat PromptIT responses as protocol payloads for their own UI.

- `normalize_prompt`: start a review session, recall similar refinements, and return a `promptit.review.v1` payload.
- `regenerate_prompt`: continue a review session when the user asks for a different version.
- `commit_prompt`: approve the current or user-edited prompt, store it in memory, record user feedback, and return `final_prompt` for the host to send.
- `prompt_it`: legacy compatibility tool that assembles `messy_text + similar refinements + host task`.
- `store_refinement`: legacy storage tool for pre-refined prompt pairs.
- `record_feedback`: legacy feedback tool for stored refinements.

PromptIT uses local Transformers.js for embeddings and recall. It does not run a generative LLM. LLM-quality rewriting should be handled by the host/agent (`prompt_engineer`) or another explicit rewrite provider, then passed back into the review protocol.

## Recommended Review Flow

This project is designed so users provide only messy text. The host agent or MCP client should automate the rest:

1. Call `normalize_prompt(messy_text=raw_user_text)`.
2. If the payload status is `needs_host_refinement`, use `conversion_context.payload` to generate `converted_prompt` according to `PROMPTENGINEER.md`.
3. Call `normalize_prompt(messy_text=raw_user_text, converted_prompt=converted_prompt)` or `regenerate_prompt(..., converted_prompt=converted_prompt)` to put that draft into review state.
4. Render the `promptit.review.v1` payload in the host as an edit/regenerate/send approval surface.
5. If the user asks for changes, call `regenerate_prompt(task_id, execution_token, user_feedback=...)`, generate the revised prompt from `regeneration_instruction`, then call `regenerate_prompt(..., converted_prompt=revised_prompt)`.
6. When the user approves, call `commit_prompt(task_id, execution_token, final_prompt=user_edited_prompt_optional, destination=host_name)`.
7. Send the returned `final_prompt` to the selected host destination. PromptIT does not own delivery.

Hard order rule:

- For medium/large/ambiguous requests, do not run web search or external tools before calling `normalize_prompt` or legacy `prompt_it`.
- Tiny mechanical tasks may use a fast path (single rename, one-line typo fix, quick grep/list/check).

The raw messy text should not be used directly as execution instructions.
Potential secret-like values (API keys/tokens/private keys) are redacted from PromptIT protocol payloads before host-side refinement.
Potential secret-like values are also redacted before persistence in `commit_prompt`/`store_refinement`, and feedback metadata is sanitized/truncated before storage.

## Review Payload Shape

`normalize_prompt`, `regenerate_prompt`, and `commit_prompt` return JSON text using this protocol marker:

```json
{
  "protocol": "promptit.review.v1",
  "status": "ready_for_review",
  "task_id": "...",
  "execution_token": "...",
  "original_prompt": "...",
  "converted_prompt": "...",
  "plan": [
    { "id": "review", "label": "Review converted prompt", "state": "ready" },
    { "id": "approve", "label": "User may edit, regenerate, or send", "state": "available" }
  ],
  "actions": ["edit", "regenerate", "send"],
  "tools": {
    "regenerate": "regenerate_prompt",
    "send": "commit_prompt"
  }
}
```

Hosts may render this as buttons, a plan panel, or plain text. The MCP server stays portable by returning structured data instead of owning UI.

## Runtime Flow

```text
[User Messy Prompt]
       |
       v
[Host App / MCP Client] -- normalize_prompt --> [PromptIT MCP Server]
       |                                             |
       |                                             v
       |                                  [SQLite history + feedback]
       |                                             |
       |                                             v
[Host UI Plan/Review Screen] <-- promptit.review.v1 payload
       |
       +--> optional user edit
       +--> optional regenerate_prompt
       |
       v
[User Clicks Send] -- commit_prompt --> [SQLite history updated]
       |
       v
[Host sends final_prompt to main LLM]
```

## MCP Enforcement (v3)

PromptIT now enforces a task token lifecycle at MCP level:

- `prompt_it` issues a per-task `TASK_ID` and `EXECUTION_TOKEN`.
- `store_refinement` and `record_feedback` hard-fail without valid token/session.
- `record_feedback` hard-fails if `store_refinement` was not completed first.
- Error codes include:
  - `ERR_PROMPT_IT_REQUIRED`
  - `ERR_INVALID_EXECUTION_TOKEN`
  - `ERR_TOKEN_EXPIRED`
  - `ERR_FLOW_INVALID`

## Token/Cost Visibility

`store_refinement` now returns an estimated token comparison on every run:

- raw messy text tokens
- refined prompt tokens
- absolute and percentage token delta

Optional cost estimation is enabled by setting:

```bash
PROMPTIT_INPUT_COST_PER_1K=0.005
```

When set, the server also prints estimated raw/refined input cost and savings.
