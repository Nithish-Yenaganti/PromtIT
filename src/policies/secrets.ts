import type { Policy } from "./types";

export const secretsPolicy: Policy = {
  riskType: "secrets_risk",
  severity: "critical",
  decision: "block",
  requiredChecks: [
    "remove secret-looking values from diff",
    "rotate exposed credentials if they were real",
    "do not commit or push until secret scan is clean",
  ],
};
