import { existsSync, readFileSync } from "fs";
import path from "path";
import { spawnSync } from "bun";
import { MAX_TEXT_CHARS } from "./config";

type PreflightArgs = {
  request: string;
  repoPath?: string;
};

type Decision = "skip" | "allow" | "warn" | "needs_confirmation" | "block";

type RiskType =
  | "safe_simple"
  | "normal_coding"
  | "database_migration"
  | "auth_security_change"
  | "production_deploy"
  | "dependency_upgrade"
  | "large_refactor"
  | "secrets_risk"
  | "infrastructure_change";

type RepoFacts = {
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

type Policy = {
  riskType: RiskType;
  severity: "low" | "medium" | "high" | "critical";
  decision: Decision;
  requiredChecks: string[];
  blockedWhen?: (facts: RepoFacts, request: string) => string[];
};

const SECRET_PATTERNS = [
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{8,}/gi,
];

const POLICIES: Record<RiskType, Policy> = {
  safe_simple: {
    riskType: "safe_simple",
    severity: "low",
    decision: "skip",
    requiredChecks: [],
  },
  normal_coding: {
    riskType: "normal_coding",
    severity: "low",
    decision: "allow",
    requiredChecks: [],
  },
  database_migration: {
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
  },
  auth_security_change: {
    riskType: "auth_security_change",
    severity: "high",
    decision: "needs_confirmation",
    requiredChecks: [
      "review auth/session/token/cookie behavior",
      "add or update security-sensitive tests",
      "check access-control boundaries",
      "do not push until user confirms auth risk",
    ],
  },
  production_deploy: {
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
  },
  dependency_upgrade: {
    riskType: "dependency_upgrade",
    severity: "medium",
    decision: "warn",
    requiredChecks: [
      "inspect package and lockfile changes",
      "identify major version upgrades",
      "run tests/build after dependency update",
      "review security audit output when available",
    ],
  },
  large_refactor: {
    riskType: "large_refactor",
    severity: "medium",
    decision: "warn",
    requiredChecks: [
      "scope the refactor before editing",
      "avoid unrelated rewrites",
      "run tests/build",
      "summarize changed modules and residual risk",
    ],
  },
  secrets_risk: {
    riskType: "secrets_risk",
    severity: "critical",
    decision: "block",
    requiredChecks: [
      "remove secret-looking values from diff",
      "rotate exposed credentials if they were real",
      "do not commit or push until secret scan is clean",
    ],
  },
  infrastructure_change: {
    riskType: "infrastructure_change",
    severity: "high",
    decision: "needs_confirmation",
    requiredChecks: [
      "review infra/deploy config changes",
      "confirm environment impact",
      "identify rollback plan",
      "run validation command when available",
    ],
  },
};

export function getPromptItToolDefinitions() {
  return [
    {
      name: "preflight_request",
      description:
        "Repo-aware safety preflight for AI coding agents. Classifies risk, inspects local repo state, and returns skip/allow/warn/needs_confirmation/block.",
      inputSchema: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The user's requested coding task.",
          },
          repo_path: {
            type: "string",
            description:
              "Optional absolute path to the target repository. Defaults to PROMPTIT_TARGET_REPO or current working directory.",
          },
        },
        required: ["request"],
      },
    },
  ];
}

export async function handlePromptItToolCall(name: string, args: unknown) {
  if (name === "preflight_request") return jsonToolResult(handlePreflightRequest(args));
  throw new Error("Tool not found");
}

function handlePreflightRequest(input: unknown) {
  const { request, repoPath } = parsePreflightArgs(input);
  const facts = inspectRepo(resolveRepoPath(repoPath));
  const riskType = classifyRisk(request, facts);
  const policy = POLICIES[riskType];
  const blockedReasons = policy.blockedWhen?.(facts, request) ?? [];
  const decision: Decision = blockedReasons.length > 0 ? "block" : policy.decision;
  const evidence = buildEvidence(request, facts, riskType, blockedReasons);

  return {
    protocol: "promptit.preflight.v1",
    decision,
    risk_type: riskType,
    severity: policy.severity,
    evidence,
    required_checks: policy.requiredChecks,
    repo_facts: {
      repo_path: facts.repo_path,
      is_git_repo: facts.is_git_repo,
      branch: facts.branch,
      dirty_files: facts.dirty_files,
      changed_files: facts.changed_files,
      staged_files: facts.staged_files,
      package_manager: facts.package_manager,
      test_scripts: facts.test_scripts,
      ci_present: facts.ci_present,
      migration_files_changed: facts.migration_files_changed,
      auth_files_changed: facts.auth_files_changed,
      deploy_files_changed: facts.deploy_files_changed,
      dependency_files_changed: facts.dependency_files_changed,
      secret_findings: facts.secret_findings,
    },
    host_instruction: buildHostInstruction(decision, riskType, policy.requiredChecks, evidence),
  };
}

function inspectRepo(repoPath: string): RepoFacts {
  const isGitRepo = git(repoPath, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  const branch = isGitRepo ? nullable(git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()) : null;
  const statusFiles = isGitRepo ? parseStatusFiles(git(repoPath, ["status", "--short"]).stdout) : [];
  const unstaged = isGitRepo ? lines(git(repoPath, ["diff", "--name-only"]).stdout) : [];
  const staged = isGitRepo ? lines(git(repoPath, ["diff", "--cached", "--name-only"]).stdout) : [];
  const changedFiles = Array.from(new Set([...statusFiles, ...unstaged, ...staged])).sort();
  const packageJson = readPackageJson(repoPath);

  return {
    repo_path: repoPath,
    is_git_repo: isGitRepo,
    branch,
    dirty_files: changedFiles.length,
    changed_files: changedFiles,
    staged_files: staged,
    package_manager: detectPackageManager(repoPath),
    test_scripts: packageJson ? Object.keys(packageJson.scripts ?? {}).filter((name) => /test|spec|check|lint|build/i.test(name)) : [],
    ci_present: hasAny(repoPath, [".github/workflows", ".gitlab-ci.yml", "circle.yml", ".circleci", "Jenkinsfile"]),
    migration_files_changed: changedFiles.filter(isMigrationFile),
    auth_files_changed: changedFiles.filter(isAuthFile),
    deploy_files_changed: changedFiles.filter(isDeployFile),
    dependency_files_changed: changedFiles.filter(isDependencyFile),
    secret_findings: isGitRepo ? countSecretFindings(git(repoPath, ["diff", "--no-ext-diff", "--unified=0"]).stdout) : 0,
  };
}

function classifyRisk(request: string, facts: RepoFacts): RiskType {
  const text = request.toLowerCase();
  if (facts.secret_findings > 0 || hasWords(text, ["secret", "api key", "token", "private key", ".env"])) {
    return "secrets_risk";
  }
  if (facts.migration_files_changed.length > 0 || hasWords(text, ["migration", "schema", "database", "db", "sql", "prisma", "typeorm"])) {
    return "database_migration";
  }
  if (facts.auth_files_changed.length > 0 || hasWords(text, ["auth", "login", "session", "cookie", "jwt", "oauth", "permission", "role", "access control"])) {
    return "auth_security_change";
  }
  if (facts.deploy_files_changed.length > 0 || hasWords(text, ["deploy", "release", "push", "production", "prod", "main branch"])) {
    return "production_deploy";
  }
  if (facts.dependency_files_changed.length > 0 || hasWords(text, ["upgrade", "dependency", "dependencies", "package", "npm install", "bun add", "major version"])) {
    return "dependency_upgrade";
  }
  if (hasWords(text, ["terraform", "kubernetes", "docker", "ci", "github action", "workflow", "infra", "infrastructure"])) {
    return "infrastructure_change";
  }
  if (hasWords(text, ["refactor", "rewrite", "large change", "cleanup entire", "restructure"]) || facts.changed_files.length >= 15) {
    return "large_refactor";
  }
  if (hasWords(text, ["fix", "implement", "add", "update", "change", "bug", "test", "typescript", "javascript", "server"])) {
    return "normal_coding";
  }
  return "safe_simple";
}

function buildEvidence(
  request: string,
  facts: RepoFacts,
  riskType: RiskType,
  blockedReasons: string[]
): string[] {
  const evidence = [...blockedReasons];
  if (riskType !== "safe_simple") evidence.push(`classified request as ${riskType}`);
  if (facts.branch) evidence.push(`current branch: ${facts.branch}`);
  if (facts.dirty_files > 0) evidence.push(`${facts.dirty_files} changed file(s) detected`);
  if (facts.migration_files_changed.length > 0) evidence.push("migration files changed");
  if (facts.auth_files_changed.length > 0) evidence.push("auth/security files changed");
  if (facts.deploy_files_changed.length > 0) evidence.push("deploy/infra files changed");
  if (facts.dependency_files_changed.length > 0) evidence.push("dependency files changed");
  if (facts.secret_findings > 0) evidence.push(`${facts.secret_findings} secret-looking diff finding(s)`);
  if (/push|deploy|release|production|main/i.test(request)) evidence.push("request includes push/deploy/release language");
  return evidence.length > 0 ? evidence : ["no risky repo signal detected"];
}

function buildHostInstruction(
  decision: Decision,
  riskType: RiskType,
  requiredChecks: string[],
  evidence: string[]
): string {
  if (decision === "skip" || decision === "allow") {
    return "Proceed normally. PromptIT did not detect a risky coding workflow.";
  }

  return [
    `PromptIT preflight decision: ${decision}`,
    `Risk type: ${riskType}`,
    "",
    "Evidence:",
    ...evidence.map((item) => `- ${item}`),
    "",
    "Required checks before execution:",
    ...requiredChecks.map((item) => `- ${item}`),
    "",
    decision === "block"
      ? "Do not continue until the blocking condition is resolved."
      : "Continue only after applying these checks; ask the user for confirmation when required.",
  ].join("\n");
}

function parsePreflightArgs(input: unknown): PreflightArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const requestRaw = args.request;
  const repoPathRaw = args.repo_path;
  assertString(requestRaw, "request");
  assertOptionalString(repoPathRaw, "repo_path");
  if (requestRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`request cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  return {
    request: requestRaw,
    repoPath: typeof repoPathRaw === "string" ? repoPathRaw : undefined,
  };
}

function resolveRepoPath(input?: string): string {
  const raw = input?.trim() || process.env.PROMPTIT_TARGET_REPO?.trim() || process.cwd();
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) throw new Error(`repo_path does not exist: ${resolved}`);
  return resolved;
}

function git(repoPath: string, args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync({
    cmd: ["git", "-C", repoPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

function parseStatusFiles(status: string): string[] {
  return lines(status)
    .map((line) => line.slice(3).trim())
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) ?? file : file)
    .filter(Boolean);
}

function lines(value: string): string[] {
  return value.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
}

function nullable(value: string): string | null {
  return value || null;
}

function detectPackageManager(repoPath: string): string | null {
  if (existsSync(path.join(repoPath, "bun.lock"))) return "bun";
  if (existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(repoPath, "package-lock.json"))) return "npm";
  return null;
}

function readPackageJson(repoPath: string): { scripts?: Record<string, string> } | null {
  const packagePath = path.join(repoPath, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    return JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
}

function hasAny(repoPath: string, relativePaths: string[]): boolean {
  return relativePaths.some((item) => existsSync(path.join(repoPath, item)));
}

function isMigrationFile(file: string): boolean {
  return /migration|migrations|schema|prisma|typeorm|knex|sequelize|db\/|database/i.test(file);
}

function isAuthFile(file: string): boolean {
  return /auth|session|cookie|jwt|oauth|permission|rbac|middleware|access/i.test(file);
}

function isDeployFile(file: string): boolean {
  return /dockerfile|docker-compose|k8s|kubernetes|terraform|helm|deploy|release|\.github\/workflows|fly\.toml|vercel|netlify|render\.yaml/i.test(file);
}

function isDependencyFile(file: string): boolean {
  return /package\.json|bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|cargo\.toml|go\.mod/i.test(file);
}

function countSecretFindings(diff: string): number {
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    const matches = diff.match(pattern);
    count += matches?.length ?? 0;
  }
  return count;
}

function hasWords(input: string, words: string[]): boolean {
  return words.some((word) => input.includes(word));
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function assertOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${name} must be a non-empty string when provided.`);
  }
}

function textToolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function jsonToolResult(payload: unknown) {
  return textToolResult(JSON.stringify(payload, null, 2));
}
