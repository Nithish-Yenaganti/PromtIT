---
description: PromptIT execution contract
alwaysApply: true
---

# AGENTS.md

## PromptIT Contract

- Refinement policy source of truth: use `PROMPTENGINEER.md` whenever `prompt_engineer` is invoked. Do not invent alternate rewrite rules outside that file.
- Transparency rule: before execution, print a short `PromptIT Pipeline (Live)` status block and update progress after each major step (received input, selected template, built host payload, generated refined prompt, review/execute, template stats recorded). Keep updates concise and never expose secrets/tokens/full local absolute paths.
- UI clarity rule: show only the converted prompt and concise review status unless the user explicitly asks for protocol JSON.
- Fast-path rule: tiny mechanical tasks may skip refinement (safe examples: single rename, one-line typo fix, quick grep/list/check, non-substantive formatting touch). Everything else must use full refinement pipeline.
- PROTOCOL: User should provide only messy text. For any new non-tiny task, you MUST run this pipeline before making any changes or perform tasks:
  1. Call `normalize_prompt(messy_text=raw_user_text)` to select a prompts.chat-style template and create a `promptit.review.v1` task.
  2. If status is `needs_host_refinement`, convert `conversion_context.payload` into a clean prompt using host-side `prompt_engineer` logic defined in `PROMPTENGINEER.md` (infer intent type and user seniority from messy text).
  3. Call `normalize_prompt(task_id, execution_token, messy_text=raw_user_text, converted_prompt=refined_text)` or `regenerate_prompt(..., converted_prompt=refined_text)` to move the draft into review state.
  4. Print the converted prompt in chat with title `Converted Prompt` and concise review actions. Do not expose secrets/tokens/full local absolute paths.
  5. If the user asks for changes, call `regenerate_prompt(task_id, execution_token, user_feedback=...)`, regenerate with host-side prompt engineering, and call `regenerate_prompt(..., converted_prompt=regenerated_text)`.
  6. When approved or when immediate execution is required by the host, call `commit_prompt(task_id, execution_token, final_prompt=approved_text, destination=host_name)`.
  7. Execute/send the returned `final_prompt` immediately. Do not assume coding-only intent.
- Never skip the refinement pipeline for medium/large/ambiguous tasks.
- Never run web search, file edits, code execution, or any external tool calls before `normalize_prompt` for medium/large/ambiguous requests.
- Never execute substantive coding work directly from messy text.
