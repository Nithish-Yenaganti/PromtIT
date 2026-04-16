---
description: PromptIT execution contract
alwaysApply: true
---

# AGENTS.md

## PromptIT Contract

- PROTOCOL: User should provide only messy text. For any new coding task, you MUST run this pipeline before writing code:
  1. Call `recall_refinements(query=messy_text)`.
  2. Build conversion input: messy text + recalled examples.
  3. Convert to a clean system prompt using host-side `prompt_engineer` logic.
  4. Call `store_refinement(raw_text, refined_text)`.
  5. Execute the coding task using `refined_text` (not raw messy text).
  6. Optionally call `record_feedback` after completion.
- Never skip the refinement pipeline for new tasks.
