import type { Policy } from "./types";

export const productionDeployPolicy: Policy = {
  riskType: "production_deploy",
  severity: "high",
  decision: "needs_confirmation",
  requiredChecks: [
    "confirm current branch and dirty working tree",
    "run relevant tests/build before deploy or push",
    "identify rollback plan",
    "require explicit user confirmation before push/deploy",
  ],
  blockedWhen: (facts, request) =>
    (facts.branch === "main" || facts.branch === "master") && /push|deploy|release/i.test(request)
      ? ["push/deploy requested while on main/master"]
      : [],
};
