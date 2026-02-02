export function normalizeWhitespace(input: string): string {
  // Preserve code blocks if present; simple approach for v1:
  // Don’t aggressively mutate inside backticks.
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractSignals(text: string) {
  const lower = text.toLowerCase();

  const hasStackTrace =
    /exception|stack trace|traceback|at\s+\w+\./i.test(text) ||
    /traceback \(most recent call last\)/i.test(text);

  const files = Array.from(text.matchAll(/(?:^|\s)([\w./-]+\.\w{1,6})(?=\s|$)/g)).map(
    (m) => m[1]
  );

  const commands = Array.from(
    text.matchAll(/(?:^|\n)\s*(npm|pnpm|yarn|pytest|python|node|go|mvn|gradle)\b[^\n]*/g)
  ).map((m) => m[0].trim());

  return { lower, hasStackTrace, files: unique(files), commands: unique(commands) };
}

function unique(arr: string[]) {
  return [...new Set(arr)].slice(0, 20);
}
