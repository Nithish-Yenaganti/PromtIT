#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { initDatabase, listSyncQueueItems } from "./database";
import {
  bootstrapPromptsChatTemplates,
  parseRetryAfterSeconds,
  syncPromptsChatTemplates,
} from "./promptsChatSync";
import {
  PROMPTS_CHAT_CATEGORY_PRESETS,
  PROMPTS_CHAT_CATEGORY_SLUGS,
  PROMPTS_CHAT_PUBLIC_CATEGORIES,
  validatePromptsChatCategories,
} from "./promptsChatCategories";

type Host = "codex" | "claude" | string;

type CliOptions = {
  args: string[];
  host?: Host;
  categories?: string[];
  preset?: string;
  dryRun: boolean;
  printConfig: boolean;
  uninstall: boolean;
  force: boolean;
  resume: boolean;
  limit?: number;
};

const rootDir = path.resolve(import.meta.dir, "..");
const serverPath = path.join(rootDir, "src", "server.ts");
const dbPath = path.join(rootDir, "data", "promptit.db");
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
  if (command === "categories") {
    printCategories();
    return;
  }
  if (command === "sync") {
    await runSync(options);
    return;
  }
  if (command === "setup") {
    options.host ??= "codex";
    options.preset ??= "developer";
    await runInstall(options, true);
    return;
  }

  if (!options.host) {
    throw new Error("Use setup, --codex, --claude, --host <name>, doctor, categories, or sync.");
  }

  await runInstall(options, false);
}

async function runInstall(options: CliOptions, runDoctorAfter: boolean): Promise<void> {
  if (!options.host) throw new Error("Host is required for install.");
  ensureRuntimeDirs();
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

  if (!options.uninstall && !options.printConfig) {
    await maybeBootstrapSelectedCategories(options);
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
    force: false,
    resume: false,
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
    } else if (arg === "--categories") {
      const value = args[i + 1]?.trim();
      if (!value) throw new Error("--categories requires comma-separated category slugs.");
      options.categories = splitCsv(value);
      i += 1;
    } else if (arg === "--preset") {
      const value = args[i + 1]?.trim();
      if (!value) throw new Error("--preset requires a preset name.");
      options.preset = value;
      i += 1;
    } else if (arg === "--limit") {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--limit requires a positive number.");
      options.limit = Math.floor(value);
      i += 1;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--print-config") options.printConfig = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg?.startsWith("--") && arg.length > 2 && !knownFlag(arg)) {
      options.host = arg.slice(2);
    }
  }

  return options;
}

async function runSync(options: CliOptions): Promise<void> {
  ensureRuntimeDirs();
  const categories = resolveSelectedCategories(options);
  if (categories.length > 0 || options.resume) {
    const result = await bootstrapPromptsChatTemplates({
      categories,
      templatesPerCategory: options.limit ?? 1,
      dryRun: options.dryRun,
      force: options.force,
      resume: options.resume,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const result = await syncPromptsChatTemplates({
    limit: options.limit,
    dryRun: options.dryRun,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function maybeBootstrapSelectedCategories(options: CliOptions): Promise<void> {
  const categories = resolveSelectedCategories(options);
  if (categories.length === 0 && !options.resume) return;

  const result = await bootstrapPromptsChatTemplates({
    categories,
    templatesPerCategory: options.limit ?? 1,
    dryRun: options.dryRun,
    force: options.force,
    resume: options.resume,
  });
  const rateLimited = result.categories.find((item) => parseRetryAfterSeconds(item.reason ?? ""));
  process.stdout.write(
    `PromptIT category sync: imported=${result.totals.imported_count}, failed=${result.totals.failed_count}\n`
  );
  if (rateLimited?.reason) {
    process.stdout.write(`prompts.chat rate limited sync; retry later with: promptit sync --resume\n`);
  }
}

function resolveSelectedCategories(options: CliOptions): string[] {
  const presetCategories = options.preset ? categoriesForPreset(options.preset) : [];
  const categories = Array.from(new Set([...(options.categories ?? []), ...presetCategories]));
  const invalid = validatePromptsChatCategories(categories);
  if (invalid.length > 0) {
    throw new Error(`Unknown prompts.chat category slug(s): ${invalid.join(", ")}`);
  }
  return categories;
}

function categoriesForPreset(preset: string): string[] {
  const categories = PROMPTS_CHAT_CATEGORY_PRESETS[preset];
  if (!categories) {
    throw new Error(
      `Unknown preset "${preset}". Available presets: ${Object.keys(PROMPTS_CHAT_CATEGORY_PRESETS).join(", ")}`
    );
  }
  return categories;
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
  ensureRuntimeDirs();
  initDatabase();
  const checks = [
    ["Bun runtime", Bun.version ? `ok (${Bun.version})` : "missing"],
    ["Server file", existsSync(serverPath) ? "ok" : `missing: ${serverPath}`],
    ["Database directory", existsSync(path.dirname(dbPath)) ? "ok" : `missing: ${path.dirname(dbPath)}`],
    ["Database path", dbPath],
    ["Codex config", existsSync(codexConfigPath()) ? `present: ${codexConfigPath()}` : "not installed"],
    ["Claude config", existsSync(claudeConfigPath()) ? `present: ${claudeConfigPath()}` : "not installed"],
    [
      "Claude instructions",
      existsSync(hostInstructionsPath("claude")) ? `present: ${hostInstructionsPath("claude")}` : "not generated",
    ],
    ["Queued sync items", String(listSyncQueueItems().length)],
  ];
  process.stdout.write("PromptIT doctor\n\n");
  for (const [label, value] of checks) {
    process.stdout.write(`${label}: ${value}\n`);
  }
}

function printCategories(): void {
  process.stdout.write("PromptIT prompts.chat categories\n\n");
  for (const item of PROMPTS_CHAT_PUBLIC_CATEGORIES) {
    process.stdout.write(`${item.category}\n`);
  }
  process.stdout.write(`\nPresets: ${Object.keys(PROMPTS_CHAT_CATEGORY_PRESETS).join(", ")}\n`);
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
    "[mcp_servers.prompt_it.env]",
    `PROMPTIT_DB_PATH = "${escapeToml(dbPath)}"`,
    "",
    "[agents.prompt_engineer]",
    'description = "Specialist in converting messy user thoughts into high-fidelity expert system prompts."',
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
    "Use the PromptIT MCP tools before executing medium, large, risky, or ambiguous user requests.",
    "Tiny mechanical tasks may skip PromptIT, such as a single rename, one-line typo fix, quick grep/list/check, or a simple direct answer.",
    "For every non-tiny request:",
    "1. Silently call prompt_it.normalize_prompt with messy_text set to the user's raw request.",
    "2. If status is needs_host_refinement, silently use conversion_context.payload to generate converted_prompt yourself with the host LLM. Do not execute the user's task yet.",
    "3. Silently call prompt_it.normalize_prompt again with task_id, execution_token, messy_text, and converted_prompt.",
    "4. When showing the review to the user, print only the converted_prompt text. Do not print a label, explanation, actions, metadata, or surrounding prose.",
    "5. If the user asks for changes, call prompt_it.regenerate_prompt with user_feedback, generate the revision, then call prompt_it.regenerate_prompt again with converted_prompt.",
    "6. When the user approves, call prompt_it.commit_prompt with task_id, execution_token, final_prompt, and destination.",
    "7. Execute or send only the returned final_prompt.",
    "Never call prompts.chat improve_prompt. PromptIT uses prompts.chat only for template discovery/search; the host LLM performs refinement.",
    "Do not show raw protocol payloads, JSON, task ids, execution tokens, selected-template internals, schema blocks, or action labels unless the user explicitly asks for them.",
  ];
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

function ensureRuntimeDirs(): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
}

function safeHostName(host: string): string {
  const safeHost = host.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeHost) throw new Error("Host name must contain at least one letter or number.");
  return safeHost;
}

function hostInstructionsPath(host: string): string {
  return path.join(rootDir, `promptit.${safeHostName(host)}.instructions.md`);
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function knownFlag(arg: string): boolean {
  return new Set([
    "--codex",
    "--claude",
    "--host",
    "--categories",
    "--preset",
    "--limit",
    "--dry-run",
    "--print-config",
    "--uninstall",
    "--force",
    "--resume",
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
      "  promptit setup --claude --preset writer",
      "  promptit --codex --preset developer",
      "  promptit --claude --categories coding,technical-writing",
      "  promptit --host my-host --print-config",
      "  promptit --cursor",
      "",
      "Sync:",
      "  promptit sync --preset developer --limit 1",
      "  promptit sync --categories coding,writing --limit 1",
      "  promptit sync --resume",
      "",
      "Utility:",
      "  promptit doctor",
      "  promptit categories",
      "  promptit --codex --uninstall",
      "",
      "Presets: developer, writer, business, creative, productivity, all",
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
