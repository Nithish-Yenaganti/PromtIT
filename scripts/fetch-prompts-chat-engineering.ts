import { bootstrapPromptsChatTemplates, syncPromptsChatTemplates } from "../src/promptsChatSync";

function parseArgs(argv: string[]): {
  keywords?: string[];
  limit?: number;
  dryRun?: boolean;
  serverUrl?: string;
  bootstrap?: boolean;
  templatesPerCategory?: number;
  force?: boolean;
} {
  const parsed: {
    keywords?: string[];
    limit?: number;
    dryRun?: boolean;
    serverUrl?: string;
    bootstrap?: boolean;
    templatesPerCategory?: number;
    force?: boolean;
  } = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keywords") {
      const value = argv[i + 1];
      if (!value) throw new Error("--keywords requires a comma-separated value.");
      parsed.keywords = value
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit requires a positive number.");
      }
      parsed.limit = Math.floor(value);
      i += 1;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--bootstrap") {
      parsed.bootstrap = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--templates-per-category") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--templates-per-category requires a positive number.");
      }
      parsed.templatesPerCategory = Math.floor(value);
      i += 1;
    } else if (arg === "--server-url") {
      const value = argv[i + 1];
      if (!value) throw new Error("--server-url requires a URL.");
      parsed.serverUrl = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  const result = options.bootstrap
    ? await bootstrapPromptsChatTemplates({
        templatesPerCategory: options.templatesPerCategory ?? options.limit,
        dryRun: options.dryRun,
        serverUrl: options.serverUrl,
        force: options.force,
      })
    : await syncPromptsChatTemplates(options);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prompts.chat sync failed: ${message}`);
  process.exit(1);
});
