import { normalizeWhitespace } from "../compiler/utils";

export type PreprocessResult = {
  text: string;
  meta: string[];
};

const SIGN_OFF_LINE = /^(thanks|thank you|best|regards|cheers|sincerely)[,!\.\s]*$/i;
const SENT_FROM_LINE = /^sent from my\b/i;
const SIGNATURE_SEPARATOR = /^--\s*$/;

export function preprocessMessyInput(raw: string): PreprocessResult {
  const meta: string[] = [];
  let text = normalizeWhitespace(raw);

  const before = text;
  text = collapseRepeatedPlease(text);
  if (text !== before) meta.push("Collapsed repeated 'please'");

  const stripped = stripTrailingNoise(text);
  if (stripped.removedLines > 0) meta.push(`Stripped ${stripped.removedLines} trailing signature/noise lines`);
  if (stripped.removedSentFrom) meta.push("Removed 'Sent from my ...' line");

  return { text: stripped.text, meta };
}

function collapseRepeatedPlease(input: string): string {
  return input.replace(/(\bplease\b[\s,!.?:;-]*){2,}/gi, "please ");
}

type StripResult = {
  text: string;
  removedLines: number;
  removedSentFrom: boolean;
};

function stripTrailingNoise(input: string): StripResult {
  const lines = input.split("\n");
  let removedLines = 0;
  let removedSentFrom = false;

  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      removedLines += 1;
      continue;
    }

    if (SENT_FROM_LINE.test(last)) {
      lines.pop();
      removedLines += 1;
      removedSentFrom = true;
      continue;
    }

    if (SIGNATURE_SEPARATOR.test(last) || SIGN_OFF_LINE.test(last)) {
      lines.pop();
      removedLines += 1;
      continue;
    }

    break;
  }

  return { text: lines.join("\n").trim(), removedLines, removedSentFrom };
}
