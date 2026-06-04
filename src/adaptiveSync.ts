import { type TemplateRecord } from "./database";
import {
  shouldSyncCategoryMore,
  syncPromptsChatForCategory,
} from "./promptsChatSync";

export function scheduleAdaptiveCategorySync(template: TemplateRecord | undefined): void {
  if (!template) return;
  const category = templateAdaptiveCategory(template);
  if (!shouldSyncCategoryMore(category)) return;

  syncPromptsChatForCategory(category).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`PromptIT adaptive prompts.chat sync skipped: ${message}\n`);
  });
}

function templateAdaptiveCategory(template: TemplateRecord): string {
  const domain = template.domain.trim().toLowerCase();
  if (domain === "software") return "coding";
  if (domain === "communication") return "writing";
  if (domain === "architecture") return "business-strategy";
  return domain || template.intent_type;
}
