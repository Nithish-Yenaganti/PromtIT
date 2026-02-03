import * as vscode from "vscode";

export type OptionalContext = {
  context: string;
  meta: string[];
};

export function collectOptionalContext(maxChars: number): OptionalContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { context: "", meta: [] };

  const sel = editor.selection;
  if (sel.isEmpty) return { context: "", meta: [] };

  const raw = editor.document.getText(sel);
  const trimmed = raw.trim();
  if (!trimmed) return { context: "", meta: [] };

  const meta: string[] = [];
  const fileName = editor.document.fileName || "Untitled";
  meta.push(`File: ${fileName}`);

  let context = trimmed;
  if (maxChars > 0 && context.length > maxChars) {
    context = `${context.slice(0, maxChars)}\n\n[CONTEXT TRUNCATED]`;
    meta.push(`Truncated to ${maxChars} chars`);
  }

  meta.push(`Context chars: ${context.length}`);

  return { context, meta };
}
