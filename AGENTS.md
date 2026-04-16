---
description: PromptIT execution contract
alwaysApply: true
---

# AGENTS.md

## PromptIT Contract

- PROTOCOL: User should provide only messy text. For any new coding task, you MUST run this pipeline before writing code:
  1. Call `prompt_it(messy_text=raw_user_text)` to fetch recall context payload.
  2. Convert that payload into a clean system prompt using host-side `prompt_engineer` logic.
  3. Print the converted prompt in chat with title `Converted Prompt`.
  4. Call `store_refinement(raw_text, refined_text)`.
  5. Execute the coding task immediately using `refined_text` (not raw messy text).
  6. Optionally call `record_feedback` after completion.
- Never skip the refinement pipeline for new tasks.
- Never execute coding work directly from messy text.
