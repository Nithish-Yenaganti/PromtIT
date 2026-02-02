// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { compilePrompt } from "./compiler/compile";
import { PROFILES, Profile } from "./compiler/profiles";


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Command 1: Compile selection or current line
  const compileCmd = vscode.commands.registerCommand("promptCompiler.compile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const profile = (vscode.workspace.getConfiguration("promptCompiler").get("profile") as Profile) || "SWE";

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

  context.subscriptions.push(compileCmd, profileCmd);
}

// This method is called when your extension is deactivated
export function deactivate() {}
