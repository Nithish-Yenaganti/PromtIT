import type { Policy } from "./types";

export const databaseMigrationPolicy: Policy = {
  riskType: "database_migration",
  severity: "high",
  decision: "needs_confirmation",
  requiredChecks: [
    "inspect existing migration history",
    "confirm rollback or reversible migration plan",
    "run migration/database tests if available",
    "do not push until user confirms migration safety",
  ],
  blockedWhen: (facts) =>
    facts.branch === "main" || facts.branch === "master"
      ? ["database migration risk detected on main/master branch"]
      : [],
};
