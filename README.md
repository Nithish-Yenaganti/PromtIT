# PromptIT MCP Server

The PromptIT is a local-first Model Context Protocol (MCP) server designed to act as a specialized bridge between a developer and an AI agent. It transforms unstructured, conversational requests into high-fidelity instructions by leveraging a persistent local memory.

## Core Logic

This server implements a Retrieval-Augmented Generation (RAG) workflow. When a user provides a raw prompt, the system does not simply pass it through. Instead, it executes the following technical sequence:

1. Semantic Fingerprinting: The server uses a local embedding model (Transformers.js) to convert the user's text into a numerical vector.
2. Memory Retrieval: It queries a local SQLite database to find historically similar prompts and their successful refinements based on vector similarity.
3. Contextual Assembly: It stores and retrieves previously accepted refinements to improve consistency over time.
4. Learning Loop: By tracking user edits and ratings, the server calculates a Levenshtein distance metric. This allows the system to prioritize examples in the future that required the fewest manual corrections.

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
1. Call prompt_it.prompt_it with messy_text.
2. Use the returned payload (messy text + similar refinements) to rewrite into a structured expert system prompt.
3. Print this to chat exactly as:
   Converted Prompt
   <converted prompt body>
4. Call prompt_it.store_refinement with both raw_text and refined_text.
5. Continue execution immediately using the refined prompt.
"""
```

Restart the extension after saving `config.toml`.

Important: use `src/server.ts` for MCP launch (not `dist/server.js`). The bundled dist runtime can fail native ONNX module resolution in Bun on some machines.

## Server Role (Storage + Recall Assembly)

This server is designed as a librarian/orchestrator backend:

- `store_refinement`: save `raw_text` + `refined_text` + embedding
- `prompt_it`: assemble `messy_text + similar refinements + host task`
- `record_feedback`: store user quality signal (`score`, `source`, `metadata`)

Refinement generation should be handled by the host/agent (`prompt_engineer`), not by this MCP server.

## Required End-to-End Flow

This project is designed so users provide only messy text. The host agent must automate the rest:

1. Call `prompt_it(messy_text=raw_user_text)`.
2. Convert returned payload to a clean system prompt with host-side prompt engineering logic.
3. Print `Converted Prompt` to chat.
4. Call `store_refinement(raw_text, refined_text)`.
5. Print the token/cost comparison returned by `store_refinement` (raw vs refined).
6. Execute coding changes from `refined_text`.
7. Optionally call `record_feedback` after completion.

The raw messy text should not be used directly as execution instructions.

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
