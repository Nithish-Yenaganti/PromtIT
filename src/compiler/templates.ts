import { Profile } from "./profiles";

export type Intent =
  | "BUGFIX"
  | "SECURITY_REVIEW"
  | "REFACTOR"
  | "PERFORMANCE"
  | "TESTS"
  | "EXPLAIN"
  | "GENERAL";

export function templateFor(profile: Profile, intent: Intent) {
  // A compact, universal “system-like wrapper”
  // Works even when pasted into normal chat boxes.
  const role =
    profile === "SECURITY"
      ? "You are a senior application security engineer."
      : profile === "BUGFIX"
      ? "You are a senior software engineer specializing in debugging and safe fixes."
      : "You are a senior software engineer focused on correct, minimal changes.";

  const intentRules = rulesFor(intent);

  return { role, intentRules };
}

function rulesFor(intent: Intent): string[] {
  const base = [
    "Do not assume missing details. If something is not provided, list it under UNRESOLVED (DO NOT GUESS).",
    "Keep scope minimal. Touch only what is necessary.",
    "Be explicit and structured. Prefer steps and concrete outputs.",
  ];

  const perIntent: Record<Intent, string[]> = {
    BUGFIX: [
      "Explain likely root cause(s) before proposing changes.",
      "Provide a patch plan and tests to prevent regressions.",
    ],
    SECURITY_REVIEW: [
      "Focus on real attack paths, not generic advice.",
      "Prioritize issues by severity and exploitability.",
      "Provide concrete fixes and safer alternatives.",
    ],
    REFACTOR: [
      "Do not change external behavior unless explicitly requested.",
      "Explain refactor intent and show before/after where relevant.",
    ],
    PERFORMANCE: [
      "Identify the bottleneck hypothesis and how to validate it.",
      "Propose measurable improvements and verification steps.",
    ],
    TESTS: [
      "Propose tests that fail before the fix and pass after.",
      "Prefer minimal, high-signal test cases.",
    ],
    EXPLAIN: [
      "Explain clearly with examples.",
      "Use short sections and avoid rambling.",
    ],
    GENERAL: [],
  };

  return [...base, ...perIntent[intent]];
}
