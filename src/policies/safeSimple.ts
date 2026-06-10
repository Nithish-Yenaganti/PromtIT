import type { Policy } from "./types";

export const safeSimplePolicy: Policy = {
  riskType: "safe_simple",
  severity: "low",
  decision: "skip",
  requiredChecks: [],
};
