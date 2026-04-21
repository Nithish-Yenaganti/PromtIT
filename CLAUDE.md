# CLAUDE.md

## PromptIT Usage Contract (Claude Code)

This project is stdio-only MCP. Use `src/server.ts` as the MCP entrypoint.

### Instruction Sources

- Primary execution contract: `AGENTS.md`
- Refinement policy source of truth: `PROMPTENGINEER.md`

### Task Routing Policy

- Tiny mechanical tasks may skip refinement:
  - single rename
  - one-line typo fix
  - quick grep/list/check
- Medium/large/ambiguous tasks must run full PromptIT flow:
  1. `prompt_it(messy_text=raw_user_text)`
  2. Extract `TASK_ID` + `EXECUTION_TOKEN`
  3. Refine using `PROMPTENGINEER.md`
  4. `store_refinement(raw_text, refined_text, task_id, execution_token)`
  5. Execute using refined prompt
  6. `record_feedback(prompt_id, score, source, metadata, task_id, execution_token)`

### Output Rules

- Print `Converted Prompt` (not raw payload/schema dumps).
- Keep status concise and transparent.
- Do not expose secrets or full absolute local paths in chat.
