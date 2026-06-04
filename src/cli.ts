#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

type Host = "codex" | "claude" | string;

const rootDir = path.resolve(import.meta.dir, "..");
const serverPath = path.join(rootDir, "src", "server.ts");
const dbPath = path.join(rootDir, "data", "promptit.db");
const managedStart = "# >>> PromptIT MCP managed block >>>";
const managedEnd = "# <<< PromptIT MCP managed block <<<";

function main(): void {
  const args = Bun.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const host = parseHost(args);
  if (!host) {
    throw new Error("Use --codex, --claude, or --host <name>.");
  }

  ensureRuntimeDirs();
  if (host === "codex") {
    installCodex();
  } else if (host === "claude") {
    installClaude();
  } else {
    writeGenericHostConfig(host);
  }
}

function parseHost(args: string[]): Host | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--codex") return "codex";
    if (arg === "--claude") return "claude";
    if (arg === "--host") {
      const value = args[i + 1]?.trim();
      if (!value) throw new Error("--host requires a host name.");
      return value;
    }
    if (arg?.startsWith("--") && arg.length > 2) {
      return arg.slice(2);
    }
  }
  return undefined;
}

function installCodex(): void {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  mkdirSync(path.dirname(configPath), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = replaceManagedBlock(current, renderCodexBlock());
  backupIfExists(configPath);
  writeFileSync(configPath, next);
  printSuccess("Codex", configPath);
}

function installClaude(): void {
  const configPath = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  );
  mkdirSync(path.dirname(configPath), { recursive: true });
  const config = readJsonObject(configPath);
  const mcpServers = objectRecord(config.mcpServers);
  mcpServers.prompt_it = renderMcpJsonServer();
  config.mcpServers = mcpServers;

  backupIfExists(configPath);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  printSuccess("Claude", configPath);
}

function writeGenericHostConfig(host: string): void {
  const safeHost = host.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeHost) throw new Error("Host name must contain at least one letter or number.");
  const outputPath = path.join(rootDir, `promptit.${safeHost}.mcp.json`);
  writeFileSync(outputPath, `${JSON.stringify({ mcpServers: { prompt_it: renderMcpJsonServer() } }, null, 2)}\n`);
  process.stdout.write(`Wrote generic PromptIT MCP config for "${host}" to:\n${outputPath}\n`);
}

function renderCodexBlock(): string {
  return [
    managedStart,
    "[mcp_servers.prompt_it]",
    'command = "bun"',
    `args = ["run", "${escapeToml(serverPath)}"]`,
    `cwd = "${escapeToml(rootDir)}"`,
    "",
    "[mcp_servers.prompt_it.env]",
    `PROMPTIT_DB_PATH = "${escapeToml(dbPath)}"`,
    "",
    "[agents.prompt_engineer]",
    'description = "Specialist in converting messy user thoughts into high-fidelity expert system prompts."',
    'mcp_servers = ["prompt_it"]',
    'developer_instructions = """',
    "You are the orchestration layer only.",
    "Follow PROMPTENGINEER.md as the single source of truth for refinement policy.",
    "For each messy request:",
    "0. For medium/large/ambiguous tasks, do not run web search, file edits, code execution, or any other tool before normalize_prompt.",
    "0b. Tiny mechanical tasks may skip PromptIT.",
    "1. Call prompt_it.normalize_prompt with messy_text.",
    "2. If status is needs_host_refinement, use conversion_context.payload to generate converted_prompt with the host LLM.",
    "3. Call prompt_it.normalize_prompt again with task_id, execution_token, messy_text, and converted_prompt.",
    "4. Show Converted Prompt and concise edit/regenerate/send actions.",
    "5. Use prompt_it.regenerate_prompt when the user requests changes.",
    "6. When approved, call prompt_it.commit_prompt with final_prompt and destination.",
    "7. Execute/send the returned final_prompt.",
    '"""',
    managedEnd,
    "",
  ].join("\n");
}

function renderMcpJsonServer(): Record<string, unknown> {
  return {
    command: "bun",
    args: ["run", serverPath],
    cwd: rootDir,
    env: {
      PROMPTIT_DB_PATH: dbPath,
    },
  };
}

function replaceManagedBlock(current: string, block: string): string {
  const start = current.indexOf(managedStart);
  const end = current.indexOf(managedEnd);
  if (start >= 0 && end > start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + managedEnd.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
  }
  return [current.trimEnd(), block.trimEnd()].filter(Boolean).join("\n\n") + "\n";
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function backupIfExists(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.promptit.bak`;
  writeFileSync(backupPath, readFileSync(filePath));
}

function ensureRuntimeDirs(): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function printSuccess(host: string, configPath: string): void {
  process.stdout.write(
    [
      `PromptIT installed for ${host}.`,
      `Updated: ${configPath}`,
      "Restart the host app so it reloads MCP servers.",
      "",
    ].join("\n")
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      "PromptIT MCP installer",
      "",
      "Usage:",
      "  promptit --codex",
      "  promptit --claude",
      "  promptit --host <name>",
      "  promptit --cursor",
      "",
      "Unknown hosts create a generic promptit.<host>.mcp.json file in this repo.",
      "",
    ].join("\n")
  );
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`promptit install failed: ${message}\n`);
  process.exit(1);
}
