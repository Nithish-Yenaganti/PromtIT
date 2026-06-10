import { existsSync, readFileSync } from "fs";
import path from "path";
import { spawnSync } from "bun";
import { MAX_TEXT_CHARS } from "./config";
import { POLICIES, type Decision, type RepoFacts, type RiskType } from "./policies";

type PreflightArgs = {
  request: string;
  repoPath?: string;
  hostClassification?: HostClassification;
};

type HostClassification = {
  riskType?: RiskType;
  confidence?: number;
  summary?: string;
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
          host_classification: {
            type: "object",
            description:
              "Optional host-LLM risk classification. PromptIT treats this as a signal only; hard repo policies still make the final decision.",
            properties: {
              risk_type: {
                type: "string",
                description:
                  "Suggested risk type: safe_simple, normal_coding, database_migration, auth_security_change, production_deploy, dependency_upgrade, large_refactor, secrets_risk, or infrastructure_change.",
              },
              confidence: {
                type: "number",
                description: "Host confidence from 0 to 1.",
              },
              summary: {
                type: "string",
                description:
                  "Short host-visible reason for the classification. Do not include secrets, raw diffs, or chain-of-thought.",
              },
            },
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
  const { request, repoPath, hostClassification } = parsePreflightArgs(input);
  const facts = inspectRepo(resolveRepoPath(repoPath));
  const localRiskType = classifyLocalRisk(request, facts);
  const riskType = selectRiskType(localRiskType, hostClassification);
  const policy = POLICIES[riskType];
  const blockedReasons = policy.blockedWhen?.(facts, request) ?? [];
  const decision: Decision = blockedReasons.length > 0 ? "block" : policy.decision;
  const evidence = buildEvidence(request, facts, riskType, localRiskType, hostClassification, blockedReasons);

  return {
    protocol: "promptit.preflight.v1",
    decision,
    risk_type: riskType,
    local_risk_type: localRiskType,
    host_classification: hostClassification
      ? {
          risk_type: hostClassification.riskType,
          confidence: hostClassification.confidence,
          summary: hostClassification.summary,
        }
      : null,
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

function classifyLocalRisk(request: string, facts: RepoFacts): RiskType {
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

function selectRiskType(localRiskType: RiskType, hostClassification?: HostClassification): RiskType {
  if (isHardRisk(localRiskType)) return localRiskType;
  if (!hostClassification?.riskType || hostClassification.confidence === undefined) return localRiskType;
  if (hostClassification.confidence < 0.65) return localRiskType;
  if (hostClassification.riskType === "safe_simple" && localRiskType !== "safe_simple") return localRiskType;
  if (riskRank(hostClassification.riskType) < riskRank(localRiskType)) return localRiskType;
  return hostClassification.riskType;
}

function isHardRisk(riskType: RiskType): boolean {
  return riskType === "secrets_risk" || riskType === "database_migration";
}

function riskRank(riskType: RiskType): number {
  const rank: Record<RiskType, number> = {
    safe_simple: 0,
    normal_coding: 1,
    dependency_upgrade: 2,
    large_refactor: 2,
    infrastructure_change: 3,
    auth_security_change: 3,
    production_deploy: 3,
    database_migration: 4,
    secrets_risk: 5,
  };
  return rank[riskType];
}

function buildEvidence(
  request: string,
  facts: RepoFacts,
  riskType: RiskType,
  localRiskType: RiskType,
  hostClassification: HostClassification | undefined,
  blockedReasons: string[]
): string[] {
  const evidence = [...blockedReasons];
  if (riskType !== "safe_simple") evidence.push(`classified request as ${riskType}`);
  if (riskType !== localRiskType) evidence.push(`host classification raised risk from ${localRiskType}`);
  if (hostClassification?.riskType && hostClassification.confidence !== undefined) {
    evidence.push(`host suggested ${hostClassification.riskType} with confidence ${hostClassification.confidence}`);
  }
  if (hostClassification?.summary) evidence.push(`host summary: ${hostClassification.summary}`);
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
  const hostClassificationRaw = args.host_classification;
  assertString(requestRaw, "request");
  assertOptionalString(repoPathRaw, "repo_path");
  if (requestRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`request cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  return {
    request: requestRaw,
    repoPath: typeof repoPathRaw === "string" ? repoPathRaw : undefined,
    hostClassification: parseHostClassification(hostClassificationRaw),
  };
}

function parseHostClassification(value: unknown): HostClassification | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host_classification must be an object when provided.");
  }

  const raw = value as Record<string, unknown>;
  const riskTypeRaw = raw.risk_type;
  const confidenceRaw = raw.confidence;
  const summaryRaw = raw.summary;

  assertOptionalString(riskTypeRaw, "host_classification.risk_type");
  assertOptionalString(summaryRaw, "host_classification.summary");

  if (riskTypeRaw !== undefined && !isRiskType(riskTypeRaw)) {
    throw new Error("host_classification.risk_type is not recognized.");
  }
  if (
    confidenceRaw !== undefined &&
    (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1)
  ) {
    throw new Error("host_classification.confidence must be a number from 0 to 1.");
  }
  if (typeof summaryRaw === "string" && summaryRaw.length > 500) {
    throw new Error("host_classification.summary cannot exceed 500 characters.");
  }

  if (riskTypeRaw === undefined && confidenceRaw === undefined && summaryRaw === undefined) return undefined;

  return {
    riskType: typeof riskTypeRaw === "string" ? riskTypeRaw : undefined,
    confidence: typeof confidenceRaw === "number" ? confidenceRaw : undefined,
    summary: typeof summaryRaw === "string" ? redactSecretLikeText(summaryRaw) : undefined,
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

function redactSecretLikeText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function hasWords(input: string, words: string[]): boolean {
  return words.some((word) => input.includes(word));
}

function isRiskType(value: string): value is RiskType {
  return Object.prototype.hasOwnProperty.call(POLICIES, value);
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
