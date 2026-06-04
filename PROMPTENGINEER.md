# PromptIT Preflight Policy

PromptIT is a safety preflight for AI coding agents.

## Purpose

Before risky coding work begins, call `prompt_it.preflight_request` and follow its decision.

PromptIT is not a prompt rewriting layer. Do not use it for normal feature work, simple fixes, explanations, or low-risk edits.

## When To Call PromptIT

Call PromptIT before work involving:

- database migrations or schema changes
- auth, sessions, cookies, tokens, permissions, or access control
- pushes, deploys, releases, or production-sensitive work
- dependency upgrades
- infrastructure, CI, Docker, Terraform, Kubernetes, or deploy config
- large refactors
- possible secrets or `.env` changes

## Decisions

- `skip`: continue normally.
- `allow`: continue normally.
- `warn`: continue, but apply `host_instruction`.
- `needs_confirmation`: show the risk summary and required checks, then wait for user confirmation before dangerous actions.
- `block`: stop until the blocking condition is fixed.

## Hard Rules

1. Do not ignore `block`.
2. Do not push, deploy, or perform destructive migration work after `needs_confirmation` until the user confirms.
3. Do not show raw diffs or secret-like values from PromptIT output.
4. Do not treat PromptIT as an LLM or prompt improver.
5. Do not store or summarize raw user prompts, repo facts, decisions, or outcomes.
