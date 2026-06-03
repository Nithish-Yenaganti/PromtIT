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
- Medium/large/ambiguous tasks must run full PromptIT review flow:
  1. `normalize_prompt(messy_text=raw_user_text)`
  2. Generate the converted prompt from the selected template and `conversion_context.payload` using `PROMPTENGINEER.md`
  3. `normalize_prompt(task_id=..., execution_token=..., messy_text=raw_user_text, converted_prompt=refined_text)`
  4. Show `Converted Prompt` and the edit/regenerate/send review state
  5. Use `regenerate_prompt` when the user requests changes
  6. `commit_prompt(task_id, execution_token, final_prompt=approved_text, destination="claude")`
  7. Send/execute the returned `final_prompt`

### Output Rules

- Print `Converted Prompt`; do not dump protocol JSON unless the user asks for it.
- Treat PromptIT as a template router and tool-only approval protocol; Claude Code owns rendering, host-LLM refinement, and final send.
- Keep status concise and transparent.
- Do not expose secrets or full absolute local paths in chat.
