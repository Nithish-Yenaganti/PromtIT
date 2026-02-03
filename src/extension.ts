// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { compilePrompt } from "./compiler/compile";
import { PROFILES, Profile } from "./compiler/profiles";
import { collectOptionalContext } from "./context/collect";
import { buildPromptRefinerInput } from "./online/promptRefiner";
import { callLLM } from "./online/provider";
import { preprocessMessyInput } from "./online/preprocess";

const API_KEY_SECRET = "promptCompiler.apiKey";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Command 1: Compile selection or current line
  const compileCmd = vscode.commands.registerCommand("promptCompiler.compile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const profile = getProfile();

    const sel = editor.selection;
    const selected = editor.document.getText(sel);
    const text = selected?.trim()
      ? selected
      : editor.document.lineAt(sel.active.line).text;

    if (!text.trim()) return;

    const compiled = compilePrompt(text, { profile });

    await editor.edit((eb) => {
      if (selected?.trim()) eb.replace(sel, compiled);
      else eb.replace(editor.document.lineAt(sel.active.line).range, compiled);
    });
  });

  // Command 3: Compile clipboard offline
  const compileClipboardOfflineCmd = vscode.commands.registerCommand("promptCompiler.compileClipboardOffline", async () => {
    const profile = getProfile();
    const rawClipboard = await vscode.env.clipboard.readText();
    const { text: messy, meta: preprocessMeta } = preprocessMessyInput(rawClipboard);
    if (!messy.trim()) {
      vscode.window.showWarningMessage("Clipboard is empty.");
      return;
    }

    const compiled = compilePrompt(messy, { profile });
    await vscode.env.clipboard.writeText(compiled);
    vscode.window.showInformationMessage("Offline compile: copied to clipboard. Paste with Cmd+V.");
  });

  // Command 4: Compile clipboard online
  const compileClipboardOnlineCmd = vscode.commands.registerCommand("promptCompiler.compileClipboardOnline", async () => {
    const config = vscode.workspace.getConfiguration("promptCompiler");
    const enableOnline = config.get<boolean>("enableOnline", false);
    if (!enableOnline) {
      vscode.window.showWarningMessage("Online compile is disabled. Enable promptCompiler.enableOnline to use it.");
      return;
    }

    const rawClipboard = await vscode.env.clipboard.readText();
    const { text: messy, meta: preprocessMeta } = preprocessMessyInput(rawClipboard);
    if (!messy.trim()) {
      vscode.window.showWarningMessage("Clipboard is empty.");
      return;
    }

    const includeContext = config.get<boolean>("includeEditorSelectionAsContext", true);
    const maxContextChars = config.get<number>("maxContextChars", 12000);
    const { context: selectionContext, meta } = includeContext
      ? collectOptionalContext(maxContextChars)
      : { context: "", meta: [] };

    const apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      vscode.window.showErrorMessage("API key not set. Run \"Prompt Compiler: Set API Key\".");
      return;
    }

    const provider = (config.get<string>("provider", "custom") || "custom").toLowerCase();
    if (provider !== "custom" && provider !== "openai") {
      vscode.window.showErrorMessage(`Provider "${provider}" is not supported yet. Use "custom" or "openai".`);
      return;
    }

    const endpoint = (config.get<string>("endpoint", "") || "").trim();
    const model = (config.get<string>("model", "") || "").trim();
    if (!endpoint || !model) {
      vscode.window.showErrorMessage("Online compile requires both endpoint and model settings.");
      return;
    }

    const confirmBefore = config.get<boolean>("confirmBeforeOnlineSend", true);
    if (confirmBefore) {
      const detailLines: string[] = [];
      detailLines.push(`Clipboard chars: ${messy.length}`);
      if (selectionContext) detailLines.push(`Context chars: ${selectionContext.length}`);
      else detailLines.push("Editor context not included.");
      if (meta.length) detailLines.push(...meta);
      if (preprocessMeta.length) detailLines.push(...preprocessMeta);

      const confirm = await vscode.window.showWarningMessage(
        "Send clipboard text to online model?",
        { modal: true, detail: detailLines.join("\n") },
        "Send"
      );
      if (confirm !== "Send") return;
    }

    const profile = getProfile();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Prompt Compiler: Online compile", cancellable: false },
      async () => {
        try {
          const { system, user } = buildPromptRefinerInput({
            messy,
            context: selectionContext,
            profile,
          });

          const output = await callLLM({
            endpoint,
            model,
            apiKey,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          });

          await vscode.env.clipboard.writeText(output);
          vscode.window.showInformationMessage("Online compile: copied to clipboard. Paste with Cmd+V.");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(message);
        }
      }
    );
  });

  // Command 5: Set API key
  const setApiKeyCmd = vscode.commands.registerCommand("promptCompiler.setApiKey", async () => {
    const key = await vscode.window.showInputBox({
      prompt: "Enter API key",
      password: true,
      ignoreFocusOut: true,
    });
    if (!key) return;

    await context.secrets.store(API_KEY_SECRET, key);
    vscode.window.showInformationMessage("API key saved securely.");
  });

  // Command 6: Clear API key
  const clearApiKeyCmd = vscode.commands.registerCommand("promptCompiler.clearApiKey", async () => {
    await context.secrets.delete(API_KEY_SECRET);
    vscode.window.showInformationMessage("API key cleared.");
  });

  // Command 2: Quick switch profile
  const profileCmd = vscode.commands.registerCommand("promptCompiler.setProfile", async () => {
    const picked = await vscode.window.showQuickPick(
      PROFILES.map((p) => ({ label: p.label, value: p.key })),
      { placeHolder: "Select Prompt Compiler profile" }
    );
    if (!picked) return;

    await vscode.workspace.getConfiguration("promptCompiler").update(
      "profile",
      picked.value,
      vscode.ConfigurationTarget.Global
    );

    vscode.window.showInformationMessage(`Prompt Compiler profile set to: ${picked.value}`);
  });

  context.subscriptions.push(
    compileCmd,
    profileCmd,
    compileClipboardOfflineCmd,
    compileClipboardOnlineCmd,
    setApiKeyCmd,
    clearApiKeyCmd
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}

function getProfile(): Profile {
  return (vscode.workspace.getConfiguration("promptCompiler").get("profile") as Profile) || "SWE";
}
