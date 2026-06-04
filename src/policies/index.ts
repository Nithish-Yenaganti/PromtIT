import { authSecurityPolicy } from "./auth";
import { databaseMigrationPolicy } from "./database";
import { dependencyUpgradePolicy } from "./dependencies";
import { productionDeployPolicy } from "./deploy";
import { infrastructurePolicy } from "./infrastructure";
import { normalCodingPolicy } from "./normalCoding";
import { largeRefactorPolicy } from "./refactor";
import { safeSimplePolicy } from "./safeSimple";
import { secretsPolicy } from "./secrets";
import type { Policy, RiskType } from "./types";

export type { Decision, Policy, RepoFacts, RiskType } from "./types";

export const POLICIES: Record<RiskType, Policy> = {
  safe_simple: safeSimplePolicy,
  normal_coding: normalCodingPolicy,
  database_migration: databaseMigrationPolicy,
  auth_security_change: authSecurityPolicy,
  production_deploy: productionDeployPolicy,
  dependency_upgrade: dependencyUpgradePolicy,
  large_refactor: largeRefactorPolicy,
  secrets_risk: secretsPolicy,
  infrastructure_change: infrastructurePolicy,
};
