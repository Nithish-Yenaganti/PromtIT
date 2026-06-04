import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "bun";

const testDbPath = path.join(os.tmpdir(), `promptit-template-ingestion-${Date.now()}.db`);
if (existsSync(testDbPath)) unlinkSync(testDbPath);
process.env.PROMPTIT_DB_PATH = testDbPath;

const { initDatabase } = await import("../src/database");
const {
  normalizePromptToTemplate,
  normalizeSearchPromptToTemplate,
  resolvePromptsChatMcpUrl,
  validateTemplateRecord,
} = await import("../src/promptsChatSync");
const { PROMPTS_CHAT_PUBLIC_CATEGORIES } = await import("../src/promptsChatCategories");
const { getPromptItToolDefinitions, handlePromptItToolCall } = await import("../src/refiner");
const { selectBestTemplate } = await import("../src/templates");

initDatabase();

test("exposes only runtime review tools through the MCP server", () => {
  const toolNames = getPromptItToolDefinitions().map((tool) => tool.name);

  expect(toolNames).toEqual(["normalize_prompt", "regenerate_prompt", "commit_prompt"]);
  expect(toolNames).not.toContain("sync_prompts_chat");
  expect(toolNames).not.toContain("bootstrap_prompts_chat");
});

test("keeps runtime server and refiner decoupled from prompts.chat ingestion", () => {
  const serverSource = readFileSync(path.resolve("src/server.ts"), "utf8");
  const refinerSource = readFileSync(path.resolve("src/refiner.ts"), "utf8");

  expect(serverSource).not.toContain("./promptsChatSync");
  expect(refinerSource).not.toContain("./promptsChatSync");
  expect(refinerSource).toContain("./adaptiveSync");
});

test("normalizes prompts.chat prompt content into a TemplateRecord", () => {
  const template = normalizePromptToTemplate(
    {
      name: "code-review",
      title: "Code Review",
      description: "Review code for bugs, regressions, missing tests, and security risks.",
    },
    {
      description: "Find issues before implementation ships.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Review the code for correctness, bugs, regressions, security risks, and missing tests. Return findings first.",
          },
        },
      ],
    }
  );

  expect(template.id).toBe("prompts-chat.code-review");
  expect(template.source).toBe("prompts.chat");
  expect(template.intent_type).toBe("coding");
  expect(template.task_type).toBe("review");
  expect(template.instructions).toContain("Use the prompts.chat template");
  expect(validateTemplateRecord(template)).toEqual([]);
});

test("normalizes search_prompts results without storing full prompt content", () => {
  const template = normalizeSearchPromptToTemplate({
    id: "code-review-assistant",
    title: "Code Review Assistant",
    description: "A prompt for conducting thorough code reviews.",
    content: "This is a long prompt body that should not be copied into local template instructions.",
    category: "Development",
    tags: ["coding", "review", "development"],
    votes: 42,
  });

  expect(template.id).toBe("prompts-chat.code-review-assistant");
  expect(template.intent_type).toBe("coding");
  expect(template.task_type).toBe("review");
  expect(template.instructions).toContain("A prompt for conducting thorough code reviews.");
  expect(template.instructions).not.toContain("This is a long prompt body");
  expect(validateTemplateRecord(template)).toEqual([]);
});

test("allows only default or explicitly allowlisted prompts.chat MCP URLs", () => {
  expect(resolvePromptsChatMcpUrl("https://prompts.chat/api/mcp")).toBe(
    "https://prompts.chat/api/mcp"
  );
  expect(() => resolvePromptsChatMcpUrl("http://prompts.chat/api/mcp")).toThrow(
    "must use https"
  );
  expect(() => resolvePromptsChatMcpUrl("https://example.com/api/mcp")).toThrow(
    "not allowed"
  );

  process.env.PROMPTIT_ALLOWED_MCP_ORIGINS = "https://example.com";
  expect(resolvePromptsChatMcpUrl("https://example.com/api/mcp")).toBe(
    "https://example.com/api/mcp"
  );
  delete process.env.PROMPTIT_ALLOWED_MCP_ORIGINS;
});

test("bootstraps across prompts.chat public category slugs", () => {
  const slugs = PROMPTS_CHAT_PUBLIC_CATEGORIES.map((item) => item.category);

  expect(slugs.length).toBeGreaterThan(40);
  expect(slugs).toContain("coding");
  expect(slugs).toContain("technical-writing");
  expect(slugs).toContain("image-generation");
  expect(slugs).toContain("research-analysis");
  expect(slugs).toContain("startup-entrepreneurship");
});

test("redacts generic secret assignments from review payloads", async () => {
  const result = await handlePromptItToolCall("normalize_prompt", {
    messy_text: "fix the api client with PROMPTS_API_KEY=super-secret-value-12345",
  });
  const textResult = result.content[0];
  expect(textResult).toBeDefined();
  if (!textResult || textResult.type !== "text") throw new Error("Expected text tool result.");
  const payload = JSON.parse(textResult.text);

  expect(payload.original_prompt).toContain("PROMPTS_API_KEY=[REDACTED_SECRET]");
  expect(payload.original_prompt).not.toContain("super-secret-value-12345");
  expect(payload.conversion_context.payload).toContain("PROMPTS_API_KEY=[REDACTED_SECRET]");
});

test("validates required template fields and quality score", () => {
  const template = normalizePromptToTemplate(
    { name: "writing-helper", title: "Writing Helper" },
    {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Write a concise explanation for a specific audience with a clear tone and length.",
          },
        },
      ],
    }
  );

  expect(validateTemplateRecord({ ...template, instructions: "" })).toContain("instructions is required");
  expect(validateTemplateRecord({ ...template, expected_output: "" })).toContain("expected_output is required");
  expect(validateTemplateRecord({ ...template, quality_score: 1.2 })).toContain(
    "quality_score must be between 0 and 1"
  );
});

test("uses stable prompt name ids for dedupe-friendly upserts", () => {
  const first = normalizePromptToTemplate(
    { name: "architecture_plan", title: "Architecture Plan" },
    {
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Plan an architecture with tradeoffs and deployment risks." },
        },
      ],
    }
  );
  const second = normalizePromptToTemplate(
    { name: "architecture_plan", title: "Architecture Plan Updated" },
    {
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Plan a cloud architecture with migration tradeoffs." },
        },
      ],
    }
  );

  expect(first.id).toBe(second.id);
  expect(first.version).not.toBe(second.version);
});

test("selects expected default templates for messy prompts", () => {
  const cases = [
    {
      prompt: "fix my bun typescript build and push it",
      intentType: "coding",
      taskType: "implementation",
    },
    {
      prompt: "review this code for bugs and missing tests",
      intentType: "coding",
      taskType: "review",
    },
    {
      prompt: "make a better architecture for local vs cloud mcp",
      intentType: "planning",
      taskType: "architecture",
    },
    {
      prompt: "write me a clean two paragraph explanation",
      intentType: "writing",
      taskType: "drafting",
    },
    {
      prompt: "compare latest tools and cite sources",
      intentType: "research",
      taskType: "research",
    },
  ];

  for (const item of cases) {
    const match = selectBestTemplate(item.prompt);
    expect(match.template.intent_type).toBe(item.intentType);
    expect(match.template.task_type).toBe(item.taskType);
  }
});

test("promptit cli writes generic MCP config for arbitrary hosts", () => {
  const outputPath = path.resolve("promptit.test-host.mcp.json");
  const instructionsPath = path.resolve("promptit.test-host.instructions.md");
  if (existsSync(outputPath)) unlinkSync(outputPath);
  if (existsSync(instructionsPath)) unlinkSync(instructionsPath);

  const result = spawnSync({
    cmd: ["bun", "run", "./src/cli.ts", "--test-host"],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(outputPath)).toBe(true);
  const config = JSON.parse(readFileSync(outputPath, "utf8"));
  expect(config.mcpServers.prompt_it.command).toBe("bun");
  expect(config.mcpServers.prompt_it.args[0]).toBe("run");
  expect(config.mcpServers.prompt_it.env.PROMPTIT_DB_PATH).toContain("data/promptit.db");
  expect(existsSync(instructionsPath)).toBe(true);
  expect(readFileSync(instructionsPath, "utf8")).toContain(
    "Silently call prompt_it.normalize_prompt"
  );

  unlinkSync(outputPath);
  unlinkSync(instructionsPath);
});

test("promptit cli previews config and rejects unknown categories", () => {
  const preview = spawnSync({
    cmd: ["bun", "run", "./src/cli.ts", "--codex", "--print-config"],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout.toString()).toContain("[mcp_servers.prompt_it]");
  expect(preview.stdout.toString()).toContain("developer_instructions");

  const genericPreview = spawnSync({
    cmd: ["bun", "run", "./src/cli.ts", "--cursor", "--print-config"],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(genericPreview.exitCode).toBe(0);
  expect(genericPreview.stdout.toString()).toContain("mcpServers");
  expect(genericPreview.stdout.toString()).toContain("PromptIT Instructions for cursor");

  const invalid = spawnSync({
    cmd: ["bun", "run", "./src/cli.ts", "sync", "--categories", "not-a-real-category", "--dry-run"],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr.toString()).toContain("Unknown prompts.chat category");
});

test("promptit setup previews codex config by default", () => {
  const setupPreview = spawnSync({
    cmd: ["bun", "run", "./src/cli.ts", "setup", "--print-config"],
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(setupPreview.exitCode).toBe(0);
  expect(setupPreview.stdout.toString()).toContain("[mcp_servers.prompt_it]");
  expect(setupPreview.stdout.toString()).toContain("developer_instructions");
});
