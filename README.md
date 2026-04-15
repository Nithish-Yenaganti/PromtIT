# PromptIT MCP Server

The PromptIT is a local-first Model Context Protocol (MCP) server designed to act as a specialized bridge between a developer and an AI agent. It transforms unstructured, conversational requests into high-fidelity instructions by leveraging a persistent local memory.

## Core Logic

This server implements a Retrieval-Augmented Generation (RAG) workflow. When a user provides a raw prompt, the system does not simply pass it through. Instead, it executes the following technical sequence:

1. Semantic Fingerprinting: The server uses a local embedding model (Transformers.js) to convert the user's text into a numerical vector.
2. Memory Retrieval: It queries a local SQLite database to find historically similar prompts and their successful refinements based on vector similarity.
3. Contextual Assembly: It constructs a Meta-Prompt that includes the current request, instructions on prompt engineering best practices, and the most relevant past examples.
4. Learning Loop: By tracking user edits and ratings, the server calculates a Levenshtein distance metric. This allows the system to prioritize examples in the future that required the fewest manual corrections.

## System Architecture

The project is divided into four functional layers:

* Transport Layer: Manages communication with MCP clients (such as Claude Code or Cursor) via Standard Input/Output (stdio).
* Database Layer: A local SQLite instance that stores raw prompts, refined outputs, and vector embeddings for long-term persistence.
* Inference Layer: Runs a local instance of the all-MiniLM-L6-v2 model to perform on-device feature extraction without external API calls.
* Logic Layer: Handles the orchestration of similarity math, feedback recording, and the assembly of the final refined instruction.

## Why MCP?

By utilizing the Model Context Protocol instead of a standard text-based instruction set, this tool gains capabilities impossible for static files:

* Stateful Memory: It maintains a history that persists across different chat sessions and different AI agents.
* Computational Logic: It can perform complex string math and database queries that are outside the scope of standard LLM context windows.
* Privacy: All data processing, including vectorization and storage, occurs on the local machine. No prompt history is sent to a third-party database for the purpose of refinement matching.

## Quick Start

```bash
bun install
bun run ./src/server.ts
```

## Fallback Behavior (Sampling -> Local Llama)

PromptIT tries MCP `sampling/createMessage` first. If the host does not support sampling, it falls back to a local model using Transformers.js:

- Default local model: `onnx-community/Llama-3.2-1B-Instruct`
- On first fallback, model files may download to local cache and take time.

Optional overrides:

```bash
PROMPTIT_LOCAL_REFINER_MODEL=onnx-community/Llama-3.2-1B-Instruct
PROMPTIT_LOCAL_MODELS_ONLY=0
PROMPTIT_LOCAL_REFINER_MAX_TOKENS=900
```
