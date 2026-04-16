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

## Codex Extension Setup (Bridge Mode)

Open your global Codex config file:

- macOS/Linux: `~/.codex/config.toml`
- Windows: `%USERPROFILE%\.codex\config.toml`

Add a server + agent bridge:

```toml
[mcp_servers.prompt_refiner]
command = "bun"
args = ["run", "/YOUR/ABSOLUTE/PATH/dist/server.js"]
cwd = "/YOUR/ABSOLUTE/PATH"

[agents.prompt_engineer]
description = "Specialist in converting messy user thoughts into high-fidelity expert system prompts."
mcp_servers = ["prompt_refiner"]
developer_instructions = """
You are a Master Prompt Engineer. When the user provides a vague request:
1. Identify the professional persona required.
2. Rewrite the request into a structured expert prompt.
3. Call prompt_refiner.store_refinement to save it locally.
4. Return ONLY the final structured prompt.
"""
```

Restart the extension after saving `config.toml`.

## Server Role (Storage + Recall)

This server is designed as a librarian/orchestrator backend:

- `store_refinement`: save `raw_text` + `refined_text` + embedding
- `recall_refinements`: retrieve similar historical refinements
- `record_feedback`: store user quality signal and edit distance

Refinement generation should be handled by the host/agent (`prompt_engineer`), not by this MCP server.
