import { Profile } from "../compiler/profiles";

type PromptInput = {
  messy: string;
  context?: string;
  profile: Profile;
};

type PromptOutput = {
  system: string;
  user: string;
};

export function buildPromptRefinerInput({ messy, context, profile }: PromptInput): PromptOutput {
  const system = [
    "You are a prompt compiler.",
    "Output ONLY the final compiled prompt.",
    "Use the exact section headers: SYSTEM, TASK, CONTEXT PROVIDED, REQUIRED OUTPUT, UNRESOLVED (DO NOT GUESS).",
    "Never add assumptions or invent details.",
    "List any missing information under UNRESOLVED (DO NOT GUESS).",
    "Follow the selected profile when choosing intent and required output.",
  ].join(" ");

  const parts: string[] = [];
  parts.push(`PROFILE: ${profile}`);
  parts.push("MESSY INPUT:");
  parts.push(messy.trim());

  if (context && context.trim()) {
    parts.push("");
    parts.push("CONTEXT (from editor selection):");
    parts.push(context.trim());
  }

  return { system, user: parts.join("\n") };
}
