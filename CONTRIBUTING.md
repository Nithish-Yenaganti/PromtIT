# Contributing to PromptIT

Search existing issues and pull requests before starting. Keep each change focused on one user-visible behavior.

## Local checks

Use Bun 1.3.12, matching CI:

```sh
bun install --frozen-lockfile
bun test
./node_modules/.bin/tsc --noEmit
bun run build
```

For policy changes, cover both the intended decision and a nearby case that should remain allowed. Use temporary test repositories rather than your real host configuration or working tree.

## Bug reports

Include the PromptIT version or commit, Bun version, operating system, request text, relevant Git state, expected decision, actual decision, and a minimal reproduction. Remove credentials and private repository content. Do not include raw secret values in a public issue.

## Pull requests

Use a title describing the behavior, such as “Block migrations on protected branches.” Explain the trigger, before/after behavior, and validation results. State which checks were not run and why. Update README examples when policy behavior changes.

If you close a PR without merging it, leave a short explanation and link to any replacement or duplicate so the outcome remains understandable.
