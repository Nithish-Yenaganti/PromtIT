---
description: PromptIT execution contract
alwaysApply: true
---

# AGENTS.md

## PromptIT Contract

- Before responding to any user task request, you MUST call the `prompt_it` tool first.
- Do not execute coding or implementation actions until refinement is accepted.
- Use the refined output from `prompt_it` as the primary instruction for execution.
- Once a task is successfully completed, call `record_feedback` with rating `1` and include user edits when available.
- Keep this refinement step silent in normal flow (do not narrate the internal refinement process).
