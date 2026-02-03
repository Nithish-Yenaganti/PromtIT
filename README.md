# Prompt Normalizer (IDE)

Prompt Normalizer is a VS Code / Cursor extension that converts unstructured developer tasks into clean, structured prompts. It supports both offline (local) and online (LLM-backed) compilation, with a clipboard-first workflow.

## What it does

- Takes messy developer input (bug notes, tasks, security checks)
- Compiles it into a structured, system-style prompt
- Does not guess missing information
- Supports offline local compilation and optional online refinement

## How to use

1. Select any text in the editor
2. Run: **Prompt Compiler: Compile Prompt**
3. The text is rewritten into a structured prompt
4. Send it to your AI agent (Cursor, Copilot-style tools)

### Clipboard workflow

- Offline: **Prompt Compiler: Compile Clipboard (Offline)** (`Cmd+Shift+U` / `Ctrl+Shift+U`)
- Online: **Prompt Compiler: Compile Clipboard (Online)** (`Cmd+Shift+I` / `Ctrl+Shift+I`)

Online mode is disabled by default. To enable it:
1. Set `promptCompiler.enableOnline` to `true`
2. Configure `promptCompiler.endpoint` and `promptCompiler.model`
3. Run **Prompt Compiler: Set API Key** to store your key securely

## Profiles

- SWE – General coding tasks
- Bugfix – Debugging and fixes
- Security – Code and security review

## Notes

- No assumptions are made
- Missing information is explicitly listed
- Designed to improve agent reliability, not replace agents

## License

MIT
