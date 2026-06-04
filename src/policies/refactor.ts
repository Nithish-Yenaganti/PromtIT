import type { Policy } from "./types";

export const largeRefactorPolicy: Policy = {
  riskType: "large_refactor",
  severity: "medium",
  decision: "warn",
  requiredChecks: [
    "scope the refactor before editing",
    "avoid unrelated rewrites",
    "run tests/build",
    "summarize changed modules and residual risk",
  ],
};
