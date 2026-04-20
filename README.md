# PromptIT MCP Server

The PromptIT is a local-first Model Context Protocol (MCP) server designed to act as a specialized bridge between a developer and an AI agent. It transforms unstructured, conversational requests into high-fidelity instructions by leveraging a persistent local memory.

## Core Logic

This server implements a Retrieval-Augmented Generation (RAG) workflow. When a user provides a raw prompt, the system does not simply pass it through. Instead, it executes the following technical sequence:

1. Semantic Fingerprinting: The server uses a local embedding model (Transformers.js) to convert the user's text into a numerical vector.
2. Memory Retrieval: It queries a local SQLite database to find historically similar prompts and their successful refinements based on vector similarity.
3. Contextual Assembly: It stores and retrieves previously accepted refinements to improve consistency over time.
4. Learning Loop: By tracking structured feedback (`score`, `source`, `metadata`), the server adjusts retrieval ranking so higher-quality past refinements are prioritized.

## System Architecture

The project is divided into four functional layers:

* Transport Layer: Manages communication with MCP clients (such as Claude Code or Codex) via Standard Input/Output (stdio).
* Database Layer: A local SQLite instance that stores raw prompts, refined outputs, and vector embeddings for long-term persistence.
* Inference Layer: Runs a local instance of the all-MiniLM-L6-v2 model to perform on-device feature extraction without external API calls.
* Logic Layer: Handles storage, recall, and feedback recording workflows.

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

## Local Browser Bridge (SSE/HTTP via Bun)

Use this when you want browser-based clients to connect locally without stdio.

Start the local bridge:

```bash
bun run start:bridge
```

Bridge endpoints:

- MCP endpoint: `http://127.0.0.1:8787/mcp`
- Health check: `http://127.0.0.1:8787/health`

Optional bridge env:

```bash
PROMPTIT_BRIDGE_HOST=127.0.0.1
PROMPTIT_BRIDGE_PORT=8787
PROMPTIT_BRIDGE_AUTH_MODE=api_key
PROMPTIT_BRIDGE_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
PROMPTIT_BRIDGE_API_KEY=change-me
```

The bridge uses MCP Streamable HTTP (SSE-capable via `GET /mcp`) and serves `POST/DELETE` on the same endpoint.

Security defaults:

- Browser requests are allowed only from loopback origins by default (`localhost` / `127.0.0.1` / `::1`).
- Add non-loopback origins explicitly via `PROMPTIT_BRIDGE_ALLOWED_ORIGINS`.
- Auth modes:
  - `api_key` (default): requires `PROMPTIT_BRIDGE_API_KEY`, accepted via `X-PromptIT-Api-Key` or `Authorization: Bearer ...`.
  - `oauth_client_credentials`: enables `/oauth/token` and `/.well-known/oauth-authorization-server` and requires bearer tokens.
  - `none`: local-only convenience mode (blocked on non-loopback host).
- If you bind bridge host to non-loopback (`0.0.0.0`, external IP), `PROMPTIT_BRIDGE_AUTH_MODE` must not be `none`.

## Stability Notes (Embedding Runtime)

PromptIT embeddings run locally via Transformers.js. For more stable local runtime behavior, use:

```bash
TRANSFORMERS_BACKEND=wasm
OMP_NUM_THREADS=1
ORT_NUM_THREADS=1
```

These are also defaulted automatically by `src/memory/embeddings.ts` when not set.

## Codex Extension Setup (Bridge Mode)

Quick auto-setup (recommended):

```bash
bash scripts/setup-codex-config.sh
```

This fills your absolute project path into `~/.codex/config.toml` automatically and backs up any existing config first.

Open your global Codex config file:

- macOS/Linux: `~/.codex/config.toml`
- Windows: `%USERPROFILE%\.codex\config.toml`

Add a server + agent bridge:

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
0. Do not run web search, file edits, code execution, or any other tools before prompt_it for a new request.
1. Call prompt_it.prompt_it with messy_text.
2. Capture TASK_ID and EXECUTION_TOKEN from the ENFORCEMENT block.
3. Use the returned payload (messy text + similar refinements) to rewrite into a structured expert system prompt.
4. Print this to chat exactly as:
   Converted Prompt
   <converted prompt body>
5. Call prompt_it.store_refinement with raw_text, refined_text, task_id, and execution_token.
6. Continue execution immediately using the refined prompt for the inferred intent type and user seniority.
7. Call prompt_it.record_feedback with prompt_id, score, source, metadata, task_id, and execution_token.
"""
```

Restart the extension after saving `config.toml`.

Important: use `src/server.ts` for MCP launch (not `dist/server.js`). The bundled dist runtime can fail native ONNX module resolution in Bun on some machines.

## Server Role (Storage + Recall Assembly)

This server is designed as a librarian/orchestrator backend:

- `store_refinement`: save `raw_text` + `refined_text` + embedding (requires task_id + execution_token from prompt_it)
- `prompt_it`: assemble `messy_text + similar refinements + host task`
- `record_feedback`: store user quality signal (`score`, `source`, `metadata`) (requires task_id + execution_token from prompt_it)

Refinement generation should be handled by the host/agent (`prompt_engineer`), not by this MCP server.

## Required End-to-End Flow

This project is designed so users provide only messy text. The host agent must automate the rest:

1. Call `prompt_it(messy_text=raw_user_text)` and capture `TASK_ID` + `EXECUTION_TOKEN`.
2. Convert returned payload to a clean system prompt with host-side prompt engineering logic.
3. Print `Converted Prompt` to chat.
4. Call `store_refinement(raw_text, refined_text, task_id, execution_token)`.
5. Print the token/cost comparison returned by `store_refinement` (raw vs refined).
6. Execute the intended task from `refined_text` (coding, writing, research, planning, support, etc.).
7. Call `record_feedback(prompt_id, score, source, metadata, task_id, execution_token)` after completion.

Hard order rule:

- For any new request, do not run web search or any external tool before calling `prompt_it`.

The raw messy text should not be used directly as execution instructions.
Potential secret-like values (API keys/tokens/private keys) are redacted from the `prompt_it` payload before host-side refinement.
Potential secret-like values are also redacted before persistence in `store_refinement`, and `record_feedback.metadata` is sanitized/truncated before storage.

OAuth connector setup (Claude custom connector):

```bash
PROMPTIT_BRIDGE_AUTH_MODE=oauth_client_credentials
PROMPTIT_OAUTH_CLIENT_ID=promptit-client
PROMPTIT_OAUTH_CLIENT_SECRET=promptit-secret
PROMPTIT_OAUTH_TOKEN_TTL_SECONDS=3600
```

Use the same client ID/secret in Claude connector advanced settings.

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
