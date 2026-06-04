#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

type Host = "codex" | "claude" | string;

type CliOptions = {
  args: string[];
  host?: Host;
  dryRun: boolean;
  printConfig: boolean;
  uninstall: boolean;
};

const rootDir = path.resolve(import.meta.dir, "..");
const serverPath = path.join(rootDir, "src", "server.ts");
const managedStart = "# >>> PromptIT MCP managed block >>>";
const managedEnd = "# <<< PromptIT MCP managed block <<<";

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  if (options.args.length === 0 || hasFlag(options.args, "--help", "-h")) {
    printHelp();
    return;
  }

  const command = options.args[0];
  if (command === "doctor") {
    runDoctor();
    return;
  }
  if (command === "setup") {
    options.host ??= "codex";
    runInstall(options, true);
    return;
  }

  if (!options.host) {
    throw new Error("Use setup, --codex, --claude, --host <name>, doctor, or --help.");
  }

  runInstall(options, false);
}

function runInstall(options: CliOptions, runDoctorAfter: boolean): void {
  if (!options.host) throw new Error("Host is required for install.");
  if (options.printConfig || options.dryRun) {
    printInstallPreview(options.host);
  } else if (options.uninstall) {
    uninstallHost(options.host);
  } else if (options.host === "codex") {
    installCodex();
  } else if (options.host === "claude") {
    installClaude();
  } else {
    writeGenericHostConfig(options.host);
  }

  if (runDoctorAfter && !options.dryRun && !options.printConfig) {
    process.stdout.write("\n");
    runDoctor();
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    args,
    dryRun: false,
    printConfig: false,
    uninstall: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--codex") options.host = "codex";
    else if (arg === "--claude") options.host = "claude";
    else if (arg === "--host") {
      const value = args[i + 1]?.trim();
      if (!value) throw new Error("--host requires a host name.");
      options.host = value;
      i += 1;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--print-config") options.printConfig = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg?.startsWith("--") && arg.length > 2 && !knownFlag(arg)) {
      options.host = arg.slice(2);
    }
  }

  return options;
}

function installCodex(): void {
  const configPath = codexConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = replaceManagedBlock(current, renderCodexBlock());
  backupIfExists(configPath);
  writeFileSync(configPath, next);
  printSuccess("Codex", configPath);
}

function installClaude(): void {
  const configPath = claudeConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  const config = readJsonObject(configPath);
  const mcpServers = objectRecord(config.mcpServers);
  mcpServers.prompt_it = renderMcpJsonServer();
  config.mcpServers = mcpServers;

  backupIfExists(configPath);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeHostInstructions("claude");
  printSuccess("Claude", configPath);
}

function uninstallHost(host: Host): void {
  if (host === "codex") {
    const configPath = codexConfigPath();
    const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    backupIfExists(configPath);
    writeFileSync(configPath, removeManagedBlock(current));
    process.stdout.write(`Removed PromptIT managed block from: ${configPath}\n`);
    return;
  }
  if (host === "claude") {
    const configPath = claudeConfigPath();
    const config = readJsonObject(configPath);
    const mcpServers = objectRecord(config.mcpServers);
    delete mcpServers.prompt_it;
    config.mcpServers = mcpServers;
    backupIfExists(configPath);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`Removed PromptIT from Claude config: ${configPath}\n`);
    process.stdout.write(`Delete this instructions file if present:\n${hostInstructionsPath("claude")}\n`);
    return;
  }
  const safeHost = safeHostName(host);
  const outputPath = path.join(rootDir, `promptit.${safeHost}.mcp.json`);
  process.stdout.write(`Delete this generic config file if present:\n${outputPath}\n`);
  process.stdout.write(`Delete this instructions file if present:\n${hostInstructionsPath(safeHost)}\n`);
}

function writeGenericHostConfig(host: string): void {
  const safeHost = safeHostName(host);
  const outputPath = path.join(rootDir, `promptit.${safeHost}.mcp.json`);
  writeFileSync(outputPath, `${JSON.stringify({ mcpServers: { prompt_it: renderMcpJsonServer() } }, null, 2)}\n`);
  const instructionsPath = writeHostInstructions(safeHost);
  process.stdout.write(`Wrote generic PromptIT MCP config for "${host}" to:\n${outputPath}\n`);
  process.stdout.write(`Wrote PromptIT host instructions to:\n${instructionsPath}\n`);
}

function runDoctor(): void {
  const checks = [
    ["Bun runtime", Bun.version ? `ok (${Bun.version})` : "missing"],
    ["Server file", existsSync(serverPath) ? "ok" : `missing: ${serverPath}`],
    ["Codex config", existsSync(codexConfigPath()) ? `present: ${codexConfigPath()}` : "not installed"],
    ["Claude config", existsSync(claudeConfigPath()) ? `present: ${claudeConfigPath()}` : "not installed"],
    [
      "Claude instructions",
      existsSync(hostInstructionsPath("claude")) ? `present: ${hostInstructionsPath("claude")}` : "not generated",
    ],
  ];
  process.stdout.write("PromptIT doctor\n\n");
  for (const [label, value] of checks) {
    process.stdout.write(`${label}: ${value}\n`);
  }
}

function printInstallPreview(host: Host): void {
  if (host === "codex") {
    process.stdout.write(`${renderCodexBlock()}\n`);
    return;
  }
  const config = { mcpServers: { prompt_it: renderMcpJsonServer() } };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n\n`);
  process.stdout.write(`${renderGenericHostInstructions(host)}\n`);
}

function renderCodexBlock(): string {
  return [
    managedStart,
    "[mcp_servers.prompt_it]",
    'command = "bun"',
    `args = ["run", "${escapeToml(serverPath)}"]`,
    `cwd = "${escapeToml(rootDir)}"`,
    "",
    "[agents.promptit_preflight]",
    'description = "Repo-aware safety preflight for risky AI coding agent workflows."',
    'mcp_servers = ["prompt_it"]',
    'developer_instructions = """',
    ...renderHostPolicyLines(),
    '"""',
    managedEnd,
    "",
  ].join("\n");
}

function writeHostInstructions(host: string): string {
  const safeHost = safeHostName(host);
  const outputPath = hostInstructionsPath(safeHost);
  writeFileSync(outputPath, `${renderGenericHostInstructions(host)}\n`);
  return outputPath;
}

function renderGenericHostInstructions(host: string): string {
  return [
    `# PromptIT Instructions for ${host}`,
    "",
    "Add this text to the host's custom instructions, project instructions, system prompt, or equivalent policy area.",
    "",
    ...renderHostPolicyLines(),
  ].join("\n");
}

function renderHostPolicyLines(): string[] {
  return [
    "You are the orchestration layer only.",
    "Use PromptIT as a repo-aware safety preflight before risky coding work.",
    "Skip PromptIT for tiny mechanical tasks, simple questions, and ordinary low-risk edits.",
    "Before executing any non-tiny coding request:",
    "1. Silently classify the user's request into a likely PromptIT risk_type with confidence and a short summary.",
    "2. Silently call prompt_it.preflight_request with request set to the user's raw request, repo_path set to the active workspace path when available, and host_classification set to that classification.",
    "3. If decision is skip or allow, proceed normally.",
    "4. If decision is warn, apply host_instruction before editing and include required checks in your work.",
    "5. If decision is needs_confirmation, show the user the risk summary and required checks, then wait for confirmation before dangerous actions.",
    "6. If decision is block, do not continue until the blocking condition is resolved.",
    "Do not use PromptIT to rewrite normal prompts. PromptIT is a safety gate, not a prompt cleaner.",
  ];
}

function renderMcpJsonServer(): Record<string, unknown> {
  return {
    command: "bun",
    args: ["run", serverPath],
    cwd: rootDir,
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

function removeManagedBlock(current: string): string {
  const start = current.indexOf(managedStart);
  const end = current.indexOf(managedEnd);
  if (start < 0 || end <= start) return current;
  const before = current.slice(0, start).trimEnd();
  const after = current.slice(end + managedEnd.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n") + (before || after ? "\n" : "");
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

function safeHostName(host: string): string {
  const safeHost = host.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeHost) throw new Error("Host name must contain at least one letter or number.");
  return safeHost;
}

function hostInstructionsPath(host: string): string {
  return path.join(rootDir, `promptit.${safeHostName(host)}.instructions.md`);
}

function knownFlag(arg: string): boolean {
  return new Set([
    "--codex",
    "--claude",
    "--host",
    "--dry-run",
    "--print-config",
    "--uninstall",
    "--help",
    "-h",
  ]).has(arg);
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function claudeConfigPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  );
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
      "Install:",
      "  promptit setup",
      "  promptit setup --claude",
      "  promptit --codex",
      "  promptit --host my-host --print-config",
      "  promptit --cursor",
      "",
      "Utility:",
      "  promptit doctor",
      "  promptit --codex --uninstall",
      "",
      "Unknown hosts create a generic promptit.<host>.mcp.json file in this repo.",
      "",
    ].join("\n")
  );
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`promptit failed: ${message}\n`);
  process.exit(1);
}
