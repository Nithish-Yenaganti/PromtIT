import type { Policy } from "./types";

export const dependencyUpgradePolicy: Policy = {
  riskType: "dependency_upgrade",
  severity: "medium",
  decision: "warn",
  requiredChecks: [
    "inspect package and lockfile changes",
    "identify major version upgrades",
    "run tests/build after dependency update",
    "review security audit output when available",
  ],
};
