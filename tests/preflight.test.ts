import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "bun";

const { getPromptItToolDefinitions, handlePromptItToolCall } = await import("../src/preflight");
const { POLICIES } = await import("../src/policies");

test("exposes only preflight runtime tools through the MCP server", () => {
  const toolNames = getPromptItToolDefinitions().map((tool) => tool.name);

  expect(toolNames).toEqual(["preflight_request"]);
});

test("exports the complete preflight policy registry", () => {
  expect(Object.keys(POLICIES).sort()).toEqual([
    "auth_security_change",
    "database_migration",
    "dependency_upgrade",
    "infrastructure_change",
    "large_refactor",
    "normal_coding",
    "production_deploy",
    "safe_simple",
    "secrets_risk",
  ]);
});

test("normal coding requests are allowed without policy friction", async () => {
  const repoPath = makeRepo();
  const result = await handlePromptItToolCall("preflight_request", {
    request: "fix the TypeScript build error",
    repo_path: repoPath,
  });
  const payload = parseToolPayload(result);

  expect(payload.protocol).toBe("promptit.preflight.v1");
  expect(payload.decision).toBe("allow");
  expect(payload.risk_type).toBe("normal_coding");
  expect(payload.required_checks).toEqual([]);
});

test("host classification can raise risk for ambiguous requests", async () => {
  const repoPath = makeRepo();
  const result = await handlePromptItToolCall("preflight_request", {
    request: "ship this today",
    repo_path: repoPath,
    host_classification: {
      risk_type: "production_deploy",
      confidence: 0.86,
      summary: "The phrase ship this likely means release or deploy work.",
    },
  });
  const payload = parseToolPayload(result);

  expect(payload.decision).toBe("block");
  expect(payload.risk_type).toBe("production_deploy");
  expect(payload.local_risk_type).toBe("safe_simple");
  expect(payload.host_classification).toEqual({
    risk_type: "production_deploy",
    confidence: 0.86,
    summary: "The phrase ship this likely means release or deploy work.",
  });
  expect(payload.evidence).toContain("production deploy risk detected on main/master branch");
  expect(payload.evidence).toContain("host classification raised risk from safe_simple");
});

test("host classification cannot lower a hard local risk", async () => {
  const repoPath = makeRepo();
  writeFileSync(path.join(repoPath, "migrations", "001_add_users.sql"), "alter table users add column name text;\n");

  const result = await handlePromptItToolCall("preflight_request", {
    request: "small cleanup",
    repo_path: repoPath,
    host_classification: {
      risk_type: "safe_simple",
      confidence: 0.99,
      summary: "Host thinks this is harmless.",
    },
  });
  const payload = parseToolPayload(result);

  expect(payload.decision).toBe("block");
  expect(payload.risk_type).toBe("database_migration");
  expect(payload.local_risk_type).toBe("database_migration");
});

test("host classification summary is redacted before output", async () => {
  const repoPath = makeRepo();
  const result = await handlePromptItToolCall("preflight_request", {
    request: "ship this today",
    repo_path: repoPath,
    host_classification: {
      risk_type: "production_deploy",
      confidence: 0.86,
      summary: "Contains token sk-proj-abcdefghijklmnopqrstuvwxyz but still means deploy.",
    },
  });
  const payload = parseToolPayload(result);
  const raw = JSON.stringify(payload);

  expect(payload.host_classification.summary).toContain("[REDACTED]");
  expect(raw).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
});

test("database migration on main is blocked with concrete evidence", async () => {
  const repoPath = makeRepo();
  writeFileSync(path.join(repoPath, "migrations", "001_add_users.sql"), "alter table users add column name text;\n");

  const result = await handlePromptItToolCall("preflight_request", {
    request: "update the user table schema and push it",
    repo_path: repoPath,
  });
  const payload = parseToolPayload(result);

  expect(payload.decision).toBe("block");
  expect(payload.risk_type).toBe("database_migration");
  expect(payload.severity).toBe("high");
  expect(payload.evidence).toContain("database migration risk detected on main/master branch");
  expect(payload.evidence).toContain("migration files changed");
  expect(payload.required_checks).toContain("confirm rollback or reversible migration plan");
});

test("secret-looking diffs are blocked without returning secret contents", async () => {
  const repoPath = makeRepo();
  const envPath = path.join(repoPath, ".env.example");
  writeFileSync(envPath, "PLACEHOLDER=1\n");
  git(repoPath, ["add", ".env.example"]);
  git(repoPath, ["commit", "-m", "seed env"]);
  writeFileSync(envPath, "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\n");

  const result = await handlePromptItToolCall("preflight_request", {
    request: "commit env update",
    repo_path: repoPath,
  });
  const payload = parseToolPayload(result);
  const raw = JSON.stringify(payload);

  expect(payload.decision).toBe("block");
  expect(payload.risk_type).toBe("secrets_risk");
  expect(payload.repo_facts.secret_findings).toBeGreaterThan(0);
  expect(raw).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
  expect(raw).not.toContain("OPENAI_API_KEY=");
});

test("promptit cli previews preflight MCP instructions", () => {
  const preview = spawnSync({
    cmd: ["bun", "run", "./src/cli.ts", "--codex", "--print-config"],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(preview.exitCode).toBe(0);
  const stdout = preview.stdout.toString();
  expect(stdout).toContain("[mcp_servers.prompt_it]");
  expect(stdout).toContain("preflight_request");
});

function makeRepo(): string {
  const repoPath = path.join(os.tmpdir(), `promptit-repo-${crypto.randomUUID()}`);
  mkdirSync(path.join(repoPath, "migrations"), { recursive: true });
  writeFileSync(
    path.join(repoPath, "package.json"),
    `${JSON.stringify({ scripts: { test: "echo test", build: "echo build" } }, null, 2)}\n`
  );
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "PromptIT Test"]);
  git(repoPath, ["add", "package.json"]);
  git(repoPath, ["commit", "-m", "seed"]);
  return repoPath;
}

function git(repoPath: string, args: string[]): void {
  const result = spawnSync({
    cmd: ["git", "-C", repoPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }
}

function parseToolPayload(result: { content: Array<{ type: string; text?: string }> }): Record<string, any> {
  const textResult = result.content[0];
  if (!textResult || textResult.type !== "text" || !textResult.text) {
    throw new Error("Expected text tool result.");
  }
  return JSON.parse(textResult.text) as Record<string, any>;
}
