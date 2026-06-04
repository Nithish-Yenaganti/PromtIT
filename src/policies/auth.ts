import type { Policy } from "./types";

export const authSecurityPolicy: Policy = {
  riskType: "auth_security_change",
  severity: "high",
  decision: "needs_confirmation",
  requiredChecks: [
    "review auth/session/token/cookie behavior",
    "add or update security-sensitive tests",
    "check access-control boundaries",
    "do not push until user confirms auth risk",
  ],
};
