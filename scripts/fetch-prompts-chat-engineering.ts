import { syncPromptsChatTemplates } from "../src/promptsChatSync";

function parseArgs(argv: string[]): {
  keywords?: string[];
  limit?: number;
  dryRun?: boolean;
  serverUrl?: string;
} {
  const parsed: {
    keywords?: string[];
    limit?: number;
    dryRun?: boolean;
    serverUrl?: string;
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
  const result = await syncPromptsChatTemplates(parseArgs(Bun.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prompts.chat sync failed: ${message}`);
  process.exit(1);
});
