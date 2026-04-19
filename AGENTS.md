---
description: PromptIT execution contract
alwaysApply: true
---

# AGENTS.md

## PromptIT Contract

- Refinement policy source of truth: use `PROMPTENGINEER.md` whenever `prompt_engineer` is invoked. Do not invent alternate rewrite rules outside that file.
- PROTOCOL: User should provide only messy text. For any new task, you MUST run this pipeline before making any changes or perform tasks:
  1. Call `prompt_it(messy_text=raw_user_text)` to fetch recall context payload.
  2. Convert that payload into a clean system prompt using host-side `prompt_engineer` logic defined in `PROMPTENGINEER.md`.
  3. Print the converted prompt in chat with title `Converted Prompt`.
  4. Call `store_refinement(raw_text, refined_text)`.
  5. Execute the coding task immediately using `refined_text` (not raw messy text).
  6. Always auto-record feedback with `record_feedback`:
     - LSP/build/test error: `score=0`, `source="LSP"`, include error details in `metadata`.
     - Agent self-correction/deviation from refined prompt: `score=0.5`, `source="Agent"`, include missing piece/deviation in `metadata`.
     - One-shot success without corrections: `score=1`, `source="Agent"`, set `metadata` to completion summary.
- Never skip the refinement pipeline for new tasks.
- Never execute coding work directly from messy text.
