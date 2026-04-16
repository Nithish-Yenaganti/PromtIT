---
description: PromptIT execution contract
alwaysApply: true
---

# AGENTS.md

## PromptIT Contract

- PROTOCOL: For any new coding task, you MUST first delegate to the `prompt_engineer` agent to refine the instructions before you begin writing code.
- The `prompt_engineer` agent should call `store_refinement` with both raw and refined text.
- Use `recall_refinements` when additional historical examples are needed for better prompt quality.
- Once execution is completed, call `record_feedback` with rating `1` and include user edits when available.
