/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.deactivate = deactivate;
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = __importStar(__webpack_require__(1));
const compile_1 = __webpack_require__(2);
const profiles_1 = __webpack_require__(5);
const collect_1 = __webpack_require__(6);
const promptRefiner_1 = __webpack_require__(7);
const provider_1 = __webpack_require__(8);
const preprocess_1 = __webpack_require__(9);
const API_KEY_SECRET = "promptCompiler.apiKey";
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
function activate(context) {
    // Command 1: Compile selection or current line
    const compileCmd = vscode.commands.registerCommand("promptCompiler.compile", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const profile = getProfile();
        const sel = editor.selection;
        const selected = editor.document.getText(sel);
        const text = selected?.trim()
            ? selected
            : editor.document.lineAt(sel.active.line).text;
        if (!text.trim())
            return;
        const compiled = (0, compile_1.compilePrompt)(text, { profile });
        await editor.edit((eb) => {
            if (selected?.trim())
                eb.replace(sel, compiled);
            else
                eb.replace(editor.document.lineAt(sel.active.line).range, compiled);
        });
    });
    // Command 3: Compile clipboard offline
    const compileClipboardOfflineCmd = vscode.commands.registerCommand("promptCompiler.compileClipboardOffline", async () => {
        const profile = getProfile();
        const rawClipboard = await vscode.env.clipboard.readText();
        const { text: messy, meta: preprocessMeta } = (0, preprocess_1.preprocessMessyInput)(rawClipboard);
        if (!messy.trim()) {
            vscode.window.showWarningMessage("Clipboard is empty.");
            return;
        }
        const compiled = (0, compile_1.compilePrompt)(messy, { profile });
        await vscode.env.clipboard.writeText(compiled);
        vscode.window.showInformationMessage("Offline compile: copied to clipboard. Paste with Cmd+V.");
    });
    // Command 4: Compile clipboard online
    const compileClipboardOnlineCmd = vscode.commands.registerCommand("promptCompiler.compileClipboardOnline", async () => {
        const config = vscode.workspace.getConfiguration("promptCompiler");
        const enableOnline = config.get("enableOnline", false);
        if (!enableOnline) {
            vscode.window.showWarningMessage("Online compile is disabled. Enable promptCompiler.enableOnline to use it.");
            return;
        }
        const rawClipboard = await vscode.env.clipboard.readText();
        const { text: messy, meta: preprocessMeta } = (0, preprocess_1.preprocessMessyInput)(rawClipboard);
        if (!messy.trim()) {
            vscode.window.showWarningMessage("Clipboard is empty.");
            return;
        }
        const includeContext = config.get("includeEditorSelectionAsContext", true);
        const maxContextChars = config.get("maxContextChars", 12000);
        const { context: selectionContext, meta } = includeContext
            ? (0, collect_1.collectOptionalContext)(maxContextChars)
            : { context: "", meta: [] };
        const apiKey = await context.secrets.get(API_KEY_SECRET);
        if (!apiKey) {
            vscode.window.showErrorMessage("API key not set. Run \"Prompt Compiler: Set API Key\".");
            return;
        }
        const provider = (config.get("provider", "custom") || "custom").toLowerCase();
        if (provider !== "custom" && provider !== "openai") {
            vscode.window.showErrorMessage(`Provider "${provider}" is not supported yet. Use "custom" or "openai".`);
            return;
        }
        const endpoint = (config.get("endpoint", "") || "").trim();
        const model = (config.get("model", "") || "").trim();
        if (!endpoint || !model) {
            vscode.window.showErrorMessage("Online compile requires both endpoint and model settings.");
            return;
        }
        const confirmBefore = config.get("confirmBeforeOnlineSend", true);
        if (confirmBefore) {
            const detailLines = [];
            detailLines.push(`Clipboard chars: ${messy.length}`);
            if (selectionContext)
                detailLines.push(`Context chars: ${selectionContext.length}`);
            else
                detailLines.push("Editor context not included.");
            if (meta.length)
                detailLines.push(...meta);
            if (preprocessMeta.length)
                detailLines.push(...preprocessMeta);
            const confirm = await vscode.window.showWarningMessage("Send clipboard text to online model?", { modal: true, detail: detailLines.join("\n") }, "Send");
            if (confirm !== "Send")
                return;
        }
        const profile = getProfile();
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Prompt Compiler: Online compile", cancellable: false }, async () => {
            try {
                const { system, user } = (0, promptRefiner_1.buildPromptRefinerInput)({
                    messy,
                    context: selectionContext,
                    profile,
                });
                const output = await (0, provider_1.callLLM)({
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
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(message);
            }
        });
    });
    // Command 5: Set API key
    const setApiKeyCmd = vscode.commands.registerCommand("promptCompiler.setApiKey", async () => {
        const key = await vscode.window.showInputBox({
            prompt: "Enter API key",
            password: true,
            ignoreFocusOut: true,
        });
        if (!key)
            return;
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
        const picked = await vscode.window.showQuickPick(profiles_1.PROFILES.map((p) => ({ label: p.label, value: p.key })), { placeHolder: "Select Prompt Compiler profile" });
        if (!picked)
            return;
        await vscode.workspace.getConfiguration("promptCompiler").update("profile", picked.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Prompt Compiler profile set to: ${picked.value}`);
    });
    context.subscriptions.push(compileCmd, profileCmd, compileClipboardOfflineCmd, compileClipboardOnlineCmd, setApiKeyCmd, clearApiKeyCmd);
}
// This method is called when your extension is deactivated
function deactivate() { }
function getProfile() {
    return vscode.workspace.getConfiguration("promptCompiler").get("profile") || "SWE";
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.compilePrompt = compilePrompt;
const templates_1 = __webpack_require__(3);
const utils_1 = __webpack_require__(4);
function compilePrompt(rawText, opts) {
    const input = (0, utils_1.normalizeWhitespace)(rawText);
    const { lower, hasStackTrace, files, commands } = (0, utils_1.extractSignals)(input);
    const intent = detectIntent(opts.profile, lower, hasStackTrace);
    const { role, intentRules } = (0, templates_1.templateFor)(opts.profile, intent);
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
function detectIntent(profile, lower, hasStackTrace) {
    // Profile can bias intent
    if (profile === "SECURITY")
        return "SECURITY_REVIEW";
    if (profile === "BUGFIX")
        return "BUGFIX";
    // Otherwise rule-based
    if (lower.includes("security") || lower.includes("vuln") || lower.includes("owasp"))
        return "SECURITY_REVIEW";
    if (hasStackTrace || lower.includes("bug") || lower.includes("error") || lower.includes("fails"))
        return "BUGFIX";
    if (lower.includes("refactor") || lower.includes("cleanup") || lower.includes("rename"))
        return "REFACTOR";
    if (lower.includes("optimize") || lower.includes("slow") || lower.includes("performance") || lower.includes("latency"))
        return "PERFORMANCE";
    if (lower.includes("test") || lower.includes("coverage") || lower.includes("unit test"))
        return "TESTS";
    if (lower.includes("explain") || lower.includes("how does") || lower.includes("what is"))
        return "EXPLAIN";
    return "GENERAL";
}
function requiredOutputFor(intent) {
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
function buildUnresolved(intent, lower) {
    const unresolved = [];
    // Only add unresolved fields if not explicitly present (no guessing)
    const mentionsLanguage = /(python|javascript|typescript|java|c\+\+|c#|go|rust|php|ruby)/i.test(lower);
    const mentionsFramework = /(react|next\.js|fastapi|django|flask|spring|dotnet|node|express)/i.test(lower);
    if (!mentionsLanguage)
        unresolved.push("Target language/runtime");
    if (!mentionsFramework && (intent === "BUGFIX" || intent === "REFACTOR"))
        unresolved.push("Framework/app type (if applicable)");
    if (intent === "BUGFIX") {
        if (!/repro|reproduce|steps/i.test(lower))
            unresolved.push("Reproduction steps");
        if (!/expected|actual/i.test(lower))
            unresolved.push("Expected vs actual behavior");
        if (!/log|trace|stack/i.test(lower))
            unresolved.push("Logs/stack trace (if available)");
    }
    if (intent === "SECURITY_REVIEW") {
        if (!/threat|attack|risk/i.test(lower))
            unresolved.push("Threat model / what to protect");
        if (!/auth|token|session|jwt/i.test(lower))
            unresolved.push("Auth/session details (if relevant)");
    }
    return unresolved.slice(0, 10);
}
function renderSystemStyle(args) {
    const lines = [];
    lines.push("SYSTEM:");
    lines.push(args.role);
    lines.push("Rules:");
    for (const r of args.rules)
        lines.push(`- ${r}`);
    lines.push("");
    lines.push("TASK:");
    lines.push(args.task);
    // Include only if found
    if (args.contextProvided.files.length || args.contextProvided.commands.length) {
        lines.push("");
        lines.push("CONTEXT PROVIDED:");
        if (args.contextProvided.files.length)
            lines.push(`- Files mentioned: ${args.contextProvided.files.join(", ")}`);
        if (args.contextProvided.commands.length)
            lines.push(`- Commands mentioned:\n  - ${args.contextProvided.commands.join("\n  - ")}`);
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


/***/ }),
/* 3 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.templateFor = templateFor;
function templateFor(profile, intent) {
    // A compact, universal “system-like wrapper”
    // Works even when pasted into normal chat boxes.
    const role = profile === "SECURITY"
        ? "You are a senior application security engineer."
        : profile === "BUGFIX"
            ? "You are a senior software engineer specializing in debugging and safe fixes."
            : "You are a senior software engineer focused on correct, minimal changes.";
    const intentRules = rulesFor(intent);
    return { role, intentRules };
}
function rulesFor(intent) {
    const base = [
        "Do not assume missing details. If something is not provided, list it under UNRESOLVED (DO NOT GUESS).",
        "Keep scope minimal. Touch only what is necessary.",
        "Be explicit and structured. Prefer steps and concrete outputs.",
    ];
    const perIntent = {
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


/***/ }),
/* 4 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.normalizeWhitespace = normalizeWhitespace;
exports.extractSignals = extractSignals;
function normalizeWhitespace(input) {
    // Preserve code blocks if present; simple approach for v1:
    // Don’t aggressively mutate inside backticks.
    return input
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function extractSignals(text) {
    const lower = text.toLowerCase();
    const hasStackTrace = /exception|stack trace|traceback|at\s+\w+\./i.test(text) ||
        /traceback \(most recent call last\)/i.test(text);
    const files = Array.from(text.matchAll(/(?:^|\s)([\w./-]+\.\w{1,6})(?=\s|$)/g)).map((m) => m[1]);
    const commands = Array.from(text.matchAll(/(?:^|\n)\s*(npm|pnpm|yarn|pytest|python|node|go|mvn|gradle)\b[^\n]*/g)).map((m) => m[0].trim());
    return { lower, hasStackTrace, files: unique(files), commands: unique(commands) };
}
function unique(arr) {
    return [...new Set(arr)].slice(0, 20);
}


/***/ }),
/* 5 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.PROFILES = void 0;
exports.PROFILES = [
    { key: "SWE", label: "SWE (General coding)" },
    { key: "BUGFIX", label: "Bugfix (Debug & patch)" },
    { key: "SECURITY", label: "Security (Review & hardening)" },
];


/***/ }),
/* 6 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.collectOptionalContext = collectOptionalContext;
const vscode = __importStar(__webpack_require__(1));
function collectOptionalContext(maxChars) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return { context: "", meta: [] };
    const sel = editor.selection;
    if (sel.isEmpty)
        return { context: "", meta: [] };
    const raw = editor.document.getText(sel);
    const trimmed = raw.trim();
    if (!trimmed)
        return { context: "", meta: [] };
    const meta = [];
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


/***/ }),
/* 7 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.buildPromptRefinerInput = buildPromptRefinerInput;
function buildPromptRefinerInput({ messy, context, profile }) {
    const system = [
        "You are a prompt compiler.",
        "Output ONLY the final compiled prompt.",
        "Use the exact section headers: SYSTEM, TASK, CONTEXT PROVIDED, REQUIRED OUTPUT, UNRESOLVED (DO NOT GUESS).",
        "Never add assumptions or invent details.",
        "List any missing information under UNRESOLVED (DO NOT GUESS).",
        "Follow the selected profile when choosing intent and required output.",
    ].join(" ");
    const parts = [];
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


/***/ }),
/* 8 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.callLLM = callLLM;
async function callLLM({ endpoint, model, apiKey, messages, temperature = 0.2 }) {
    if (!endpoint)
        throw new Error("Online compile: endpoint is not configured.");
    if (!model)
        throw new Error("Online compile: model is not configured.");
    if (!apiKey)
        throw new Error("Online compile: API key is missing.");
    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            temperature,
        }),
    });
    if (!res.ok) {
        const body = await safeReadText(res);
        throw new Error(`Online compile failed (${res.status} ${res.statusText}). ${body}`.trim());
    }
    const json = (await res.json());
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) {
        throw new Error("Online compile failed: empty response content.");
    }
    return content;
}
async function safeReadText(res) {
    try {
        const text = await res.text();
        return text ? text.slice(0, 400) : "";
    }
    catch {
        return "";
    }
}


/***/ }),
/* 9 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.preprocessMessyInput = preprocessMessyInput;
const utils_1 = __webpack_require__(4);
const SIGN_OFF_LINE = /^(thanks|thank you|best|regards|cheers|sincerely)[,!\.\s]*$/i;
const SENT_FROM_LINE = /^sent from my\b/i;
const SIGNATURE_SEPARATOR = /^--\s*$/;
function preprocessMessyInput(raw) {
    const meta = [];
    let text = (0, utils_1.normalizeWhitespace)(raw);
    const before = text;
    text = collapseRepeatedPlease(text);
    if (text !== before)
        meta.push("Collapsed repeated 'please'");
    const stripped = stripTrailingNoise(text);
    if (stripped.removedLines > 0)
        meta.push(`Stripped ${stripped.removedLines} trailing signature/noise lines`);
    if (stripped.removedSentFrom)
        meta.push("Removed 'Sent from my ...' line");
    return { text: stripped.text, meta };
}
function collapseRepeatedPlease(input) {
    return input.replace(/(\bplease\b[\s,!.?:;-]*){2,}/gi, "please ");
}
function stripTrailingNoise(input) {
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


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map