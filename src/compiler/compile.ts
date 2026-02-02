import { Profile } from "./profiles";
import { Intent, templateFor } from "./templates";
import { extractSignals, normalizeWhitespace } from "./utils";

export type CompileOptions = {
  profile: Profile;
};

export function compilePrompt(rawText: string, opts: CompileOptions): string {
  const input = normalizeWhitespace(rawText);
  const { lower, hasStackTrace, files, commands } = extractSignals(input);

  const intent = detectIntent(opts.profile, lower, hasStackTrace);
  const { role, intentRules } = templateFor(opts.profile, intent);

  const unresolved = buildUnresolved(intent, lower);

  return renderSystemStyle({
    role,
    rules: intentRules,
    task: input,
    contextProvided: { files, commands },
    requiredOutput: requiredOutputFor(intent),
    unresolved,
  });
}

function detectIntent(profile: Profile, lower: string, hasStackTrace: boolean): Intent {
  // Profile can bias intent
  if (profile === "SECURITY") return "SECURITY_REVIEW";
  if (profile === "BUGFIX") return "BUGFIX";

  // Otherwise rule-based
  if (lower.includes("security") || lower.includes("vuln") || lower.includes("owasp")) return "SECURITY_REVIEW";
  if (hasStackTrace || lower.includes("bug") || lower.includes("error") || lower.includes("fails")) return "BUGFIX";
  if (lower.includes("refactor") || lower.includes("cleanup") || lower.includes("rename")) return "REFACTOR";
  if (lower.includes("optimize") || lower.includes("slow") || lower.includes("performance") || lower.includes("latency")) return "PERFORMANCE";
  if (lower.includes("test") || lower.includes("coverage") || lower.includes("unit test")) return "TESTS";
  if (lower.includes("explain") || lower.includes("how does") || lower.includes("what is")) return "EXPLAIN";

  return "GENERAL";
}

function requiredOutputFor(intent: Intent): string[] {
  switch (intent) {
    case "BUGFIX":
      return [
        "Root cause analysis (based only on provided info)",
        "Fix plan (file-level steps)",
        "Patch or code changes (diff-style if possible)",
        "Tests to add/update",
        "Risk + rollback notes",
      ];
    case "SECURITY_REVIEW":
      return [
        "Findings prioritized by severity (with reasoning)",
        "Concrete fixes and safer alternatives",
        "Any code/config changes needed (specific, minimal)",
        "Verification steps (how to prove it’s fixed)",
      ];
    case "REFACTOR":
      return [
        "Refactor plan (what/why)",
        "Proposed code changes (minimal, behavior-preserving)",
        "Any tests or checks to confirm no regression",
      ];
    case "PERFORMANCE":
      return [
        "Bottleneck hypothesis + how to validate",
        "Optimization plan with measurable impact",
        "Concrete code/query changes",
        "How to benchmark/verify improvements",
      ];
    case "TESTS":
      return [
        "Test strategy (what to cover and why)",
        "Concrete test cases",
        "Test code snippets",
      ];
    case "EXPLAIN":
      return [
        "Clear explanation with examples",
        "If relevant: pitfalls and best practices",
      ];
    default:
      return [
        "Structured answer",
        "Concrete next steps",
      ];
  }
}

function buildUnresolved(intent: Intent, lower: string): string[] {
  const unresolved: string[] = [];

  // Only add unresolved fields if not explicitly present (no guessing)
  const mentionsLanguage = /(python|javascript|typescript|java|c\+\+|c#|go|rust|php|ruby)/i.test(lower);
  const mentionsFramework = /(react|next\.js|fastapi|django|flask|spring|dotnet|node|express)/i.test(lower);

  if (!mentionsLanguage) unresolved.push("Target language/runtime");
  if (!mentionsFramework && (intent === "BUGFIX" || intent === "REFACTOR")) unresolved.push("Framework/app type (if applicable)");

  if (intent === "BUGFIX") {
    if (!/repro|reproduce|steps/i.test(lower)) unresolved.push("Reproduction steps");
    if (!/expected|actual/i.test(lower)) unresolved.push("Expected vs actual behavior");
    if (!/log|trace|stack/i.test(lower)) unresolved.push("Logs/stack trace (if available)");
  }

  if (intent === "SECURITY_REVIEW") {
    if (!/threat|attack|risk/i.test(lower)) unresolved.push("Threat model / what to protect");
    if (!/auth|token|session|jwt/i.test(lower)) unresolved.push("Auth/session details (if relevant)");
  }

  return unresolved.slice(0, 10);
}

function renderSystemStyle(args: {
  role: string;
  rules: string[];
  task: string;
  contextProvided: { files: string[]; commands: string[] };
  requiredOutput: string[];
  unresolved: string[];
}): string {
  const lines: string[] = [];

  lines.push("SYSTEM:");
  lines.push(args.role);
  lines.push("Rules:");
  for (const r of args.rules) lines.push(`- ${r}`);

  lines.push("");
  lines.push("TASK:");
  lines.push(args.task);

  // Include only if found
  if (args.contextProvided.files.length || args.contextProvided.commands.length) {
    lines.push("");
    lines.push("CONTEXT PROVIDED:");
    if (args.contextProvided.files.length) lines.push(`- Files mentioned: ${args.contextProvided.files.join(", ")}`);
    if (args.contextProvided.commands.length) lines.push(`- Commands mentioned:\n  - ${args.contextProvided.commands.join("\n  - ")}`);
  }

  lines.push("");
  lines.push("REQUIRED OUTPUT:");
  args.requiredOutput.forEach((x, i) => lines.push(`${i + 1}) ${x}`));

  if (args.unresolved.length) {
    lines.push("");
    lines.push("UNRESOLVED (DO NOT GUESS):");
    args.unresolved.forEach((u) => lines.push(`- ${u}`));
  }

  return lines.join("\n");
}
