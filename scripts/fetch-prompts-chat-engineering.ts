import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GetPromptResultSchema, ListPromptsResultSchema } from "@modelcontextprotocol/sdk/types.js";

type PromptItem = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

const DEFAULT_KEYWORDS = ["software", "linux", "developer", "engineering", "programming", "devops"];

function getKeywords(): string[] {
  const raw = process.env.PROMPTS_CHAT_KEYWORDS?.trim();
  if (!raw) return DEFAULT_KEYWORDS;
  return raw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function isEngineeringPrompt(prompt: PromptItem, keywords: string[]): boolean {
  const haystack = [
    prompt.name,
    prompt.title ?? "",
    prompt.description ?? "",
    ...(prompt.arguments ?? []).map((a) => `${a.name} ${a.description ?? ""}`),
  ]
    .join(" ")
    .toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

function buildHeaders(): HeadersInit | undefined {
  const bearer = process.env.PROMPTS_CHAT_BEARER_TOKEN?.trim() || process.env.PROMPTS_CHAT_API_KEY?.trim();
  if (!bearer) return undefined;
  return { Authorization: `Bearer ${bearer}` };
}

async function main() {
  const serverUrl = process.env.PROMPTS_CHAT_MCP_URL?.trim();
  if (!serverUrl) {
    throw new Error("PROMPTS_CHAT_MCP_URL is required (example: https://prompts.chat/mcp).");
  }

  const keywords = getKeywords();
  const headers = buildHeaders();
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: headers ? { headers } : undefined,
  });

  const client = new Client(
    { name: "promptit-prompts-chat-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  try {
    const prompts: PromptItem[] = [];
    let cursor: string | undefined = undefined;

    // Pull all pages from prompts/list.
    do {
      const listResult = await client.request(
        { method: "prompts/list", params: cursor ? { cursor } : {} },
        ListPromptsResultSchema
      );
      prompts.push(...listResult.prompts);
      cursor = listResult.nextCursor;
    } while (cursor);

    const matches = prompts.filter((p) => isEngineeringPrompt(p, keywords));
    console.log(`Total prompts: ${prompts.length}`);
    console.log(`Engineering matches: ${matches.length}`);

    for (const prompt of matches) {
      const requiredArgs = (prompt.arguments ?? []).filter((a) => a.required).map((a) => a.name);
      const args =
        requiredArgs.length > 0
          ? Object.fromEntries(requiredArgs.map((name) => [name, process.env[`PROMPTS_CHAT_ARG_${name.toUpperCase()}`] ?? ""]))
          : {};

      console.log(`\n=== ${prompt.title ?? prompt.name} (${prompt.name}) ===`);
      if (prompt.description) console.log(`Description: ${prompt.description}`);

      try {
        const full = await client.request(
          { method: "prompts/get", params: { name: prompt.name, arguments: args } },
          GetPromptResultSchema
        );
        if (full.description) console.log(`Full Description: ${full.description}`);
        full.messages.forEach((m, i) => {
          if (m.content.type === "text") {
            console.log(`[${i + 1}] ${m.role}: ${m.content.text}`);
          } else {
            console.log(`[${i + 1}] ${m.role}: <${m.content.type}>`);
          }
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`Failed to fetch full content for "${prompt.name}": ${message}`);
      }
    }
  } finally {
    await transport.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prompts.chat fetch failed: ${message}`);
  process.exit(1);
});
