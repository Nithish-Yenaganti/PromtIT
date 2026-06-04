import type { Policy } from "./types";

export const infrastructurePolicy: Policy = {
  riskType: "infrastructure_change",
  severity: "high",
  decision: "needs_confirmation",
  requiredChecks: [
    "review infra/deploy config changes",
    "confirm environment impact",
    "identify rollback plan",
    "run validation command when available",
  ],
};
