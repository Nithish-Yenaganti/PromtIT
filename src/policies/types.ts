export type Decision = "skip" | "allow" | "warn" | "needs_confirmation" | "block";

export type RiskType =
  | "safe_simple"
  | "normal_coding"
  | "database_migration"
  | "auth_security_change"
  | "production_deploy"
  | "dependency_upgrade"
  | "large_refactor"
  | "secrets_risk"
  | "infrastructure_change";

export type RepoFacts = {
  repo_path: string;
  is_git_repo: boolean;
  branch: string | null;
  dirty_files: number;
  changed_files: string[];
  staged_files: string[];
  package_manager: string | null;
  test_scripts: string[];
  ci_present: boolean;
  migration_files_changed: string[];
  auth_files_changed: string[];
  deploy_files_changed: string[];
  dependency_files_changed: string[];
  secret_findings: number;
};

export type Policy = {
  riskType: RiskType;
  severity: "low" | "medium" | "high" | "critical";
  decision: Decision;
  requiredChecks: string[];
  blockedWhen?: (facts: RepoFacts, request: string) => string[];
};
