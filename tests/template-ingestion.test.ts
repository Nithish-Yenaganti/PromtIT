import { expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import os from "os";
import path from "path";

const testDbPath = path.join(os.tmpdir(), `promptit-template-ingestion-${Date.now()}.db`);
if (existsSync(testDbPath)) unlinkSync(testDbPath);
process.env.PROMPTIT_DB_PATH = testDbPath;

const { initDatabase } = await import("../src/database");
const { normalizePromptToTemplate, normalizeSearchPromptToTemplate, validateTemplateRecord } =
  await import("../src/promptsChatSync");
const { selectBestTemplate } = await import("../src/templates");

initDatabase();

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
