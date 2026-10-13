import * as vscode from "vscode";
import { askAboutLine, JevError } from "./jev";

const SECRET_KEY = "jev.apiKey";

type Entry =
  | { status: "dirty"; text: string }
  | { status: "pending"; text: string }
  | { status: "done"; text: string; noul: number; prompt: string; thumbsUp: boolean };

interface DocState {
  // Keyed by line number; shifted as lines are inserted or removed above them.
  entries: Map<number, Entry>;
  lastLine?: number;
}

const docs = new Map<string, DocState>();
let decoration: vscode.TextEditorDecorationType;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let secrets: vscode.SecretStorage;
let warnedMissingKey = false;

export function activate(context: vscode.ExtensionContext) {
  secrets = context.secrets;
  output = vscode.window.createOutputChannel("Jev");
  decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 1.5em" },
  });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "jev.toggle";
  updateStatusBar();
  statusBar.show();

  context.subscriptions.push(
    output,
    decoration,
    statusBar,
    vscode.workspace.onDidChangeTextDocument(onDocumentChanged),
    vscode.window.onDidChangeTextEditorSelection(onSelectionChanged),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => render(e.document))),
    vscode.workspace.onDidSaveTextDocument(flushLastLine),
    vscode.workspace.onDidCloseTextDocument((doc) => docs.delete(doc.uri.toString())),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("jev.enabled")) {
        updateStatusBar();
        vscode.window.visibleTextEditors.forEach((e) => render(e.document));
      }
    }),
    vscode.commands.registerCommand("jev.setApiKey", setApiKey),
    vscode.commands.registerCommand("jev.toggle", () =>
      config().update("enabled", !config().get<boolean>("enabled"), vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand("jev.evaluateLine", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        evaluate(editor.document, editor.selection.active.line, true);
      }
    }),
    vscode.commands.registerCommand("jev.clear", () => {
      docs.clear();
      vscode.window.visibleTextEditors.forEach((e) => e.setDecorations(decoration, []));
    }),
  );
}

export function deactivate() {}

function config() {
  return vscode.workspace.getConfiguration("jev");
}

function isTracked(doc: vscode.TextDocument) {
  return doc.uri.scheme === "file" || doc.uri.scheme === "untitled";
}

function stateFor(doc: vscode.TextDocument): DocState {
  const key = doc.uri.toString();
  let state = docs.get(key);
  if (!state) {
    state = { entries: new Map() };
    docs.set(key, state);
  }
  return state;
}

function updateStatusBar() {
  const enabled = config().get<boolean>("enabled");
  statusBar.text = enabled ? "Jev 👍" : "Jev off";
  statusBar.tooltip = enabled ? "Jev is checking your lines. Click to turn off." : "Click to turn Jev on.";
}

// Keep entries attached to the right lines as text is edited, and mark edited lines dirty.
function onDocumentChanged(e: vscode.TextDocumentChangeEvent) {
  if (!isTracked(e.document) || e.contentChanges.length === 0) {
    return;
  }
  const state = stateFor(e.document);

  // Apply bottom-up so earlier ranges stay valid against the original document.
  const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
  for (const change of changes) {
    const start = change.range.start.line;
    const end = change.range.end.line;
    const added = change.text.split("\n").length - 1;
    const delta = added - (end - start);

    const shifted = new Map<number, Entry>();
    for (const [line, entry] of state.entries) {
      if (line < start) {
        shifted.set(line, entry);
      } else if (line > end) {
        shifted.set(line + delta, entry);
      }
    }
    for (let line = start; line <= start + added; line++) {
      shifted.set(line, { status: "dirty", text: "" });
    }
    state.entries = shifted;

    if (state.lastLine !== undefined && state.lastLine > end) {
      state.lastLine += delta;
    }
  }

  render(e.document);
}

// A line is "written" once the cursor leaves it after editing.
function onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent) {
  const doc = e.textEditor.document;
  if (!isTracked(doc)) {
    return;
  }
  const state = stateFor(doc);
  const line = e.selections[0].active.line;
  if (state.lastLine !== undefined && state.lastLine !== line) {
    flushLastLine(doc);
  }
  state.lastLine = line;
}

function flushLastLine(doc: vscode.TextDocument) {
  const state = docs.get(doc.uri.toString());
  if (state?.lastLine !== undefined && state.entries.get(state.lastLine)?.status === "dirty") {
    evaluate(doc, state.lastLine);
  }
}

async function getApiKey(): Promise<string | undefined> {
  return (await secrets.get(SECRET_KEY)) || process.env.TYPESAFE_API_KEY || undefined;
}

async function setApiKey() {
  const key = await vscode.window.showInputBox({
    prompt: "TypeSafe API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await secrets.store(SECRET_KEY, key.trim());
    warnedMissingKey = false;
    vscode.window.showInformationMessage("Jev API key saved.");
  }
}

async function evaluate(doc: vscode.TextDocument, line: number, force = false) {
  const cfg = config();
  if ((!cfg.get<boolean>("enabled") && !force) || line >= doc.lineCount) {
    return;
  }
  const state = stateFor(doc);
  const text = doc.lineAt(line).text;
  if (text.trim() === "") {
    state.entries.delete(line);
    render(doc);
    return;
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      const choice = await vscode.window.showWarningMessage(
        "Jev needs a TypeSafe API key to check your lines.",
        "Set API Key",
      );
      if (choice) {
        await setApiKey();
      }
    }
    return;
  }

  const prompt = cfg.get<string>("prompt") || "is this ok?";
  const contextLines = cfg.get<number>("contextLines") ?? 5;
  const entry: Entry = { status: "pending", text };
  state.entries.set(line, entry);
  render(doc);

  const lines = (from: number, to: number) => {
    const out: string[] = [];
    for (let i = Math.max(0, from); i < Math.min(doc.lineCount, to); i++) {
      out.push(doc.lineAt(i).text);
    }
    return out;
  };

  let result: Entry | undefined;
  try {
    const noul = await askAboutLine(apiKey, cfg.get<string>("model") || "jev-latest", prompt, {
      language: doc.languageId,
      line: { number: line + 1, text },
      context_before: lines(line - contextLines, line),
      context_after: lines(line + 1, line + 1 + contextLines),
    });
    const thumbsUp = noul >= (cfg.get<number>("threshold") ?? 0.5);
    result = { status: "done", text, noul, prompt, thumbsUp };
    output.appendLine(`${thumbsUp ? "👍" : "👎"} ${noul.toFixed(2)}  ${doc.fileName}:${line + 1}  ${text.trim()}`);
  } catch (err) {
    output.appendLine(`Error checking ${doc.fileName}:${line + 1}: ${err instanceof Error ? err.message : err}`);
    if (err instanceof JevError && err.status === 401) {
      vscode.window.showErrorMessage("Jev: TypeSafe rejected the API key.", "Set API Key").then((c) => {
        if (c) {
          setApiKey();
        }
      });
    }
  }

  // The line may have moved, or been edited again, while the request was in flight.
  for (const [current, e] of state.entries) {
    if (e === entry) {
      if (result) {
        state.entries.set(current, result);
      } else {
        state.entries.delete(current);
      }
    }
  }
  render(doc);
}

function render(doc: vscode.TextDocument) {
  const editors = vscode.window.visibleTextEditors.filter((e) => e.document === doc);
  if (editors.length === 0) {
    return;
  }
  const options: vscode.DecorationOptions[] = [];
  const state = docs.get(doc.uri.toString());
  if (state && config().get<boolean>("enabled")) {
    for (const [line, entry] of state.entries) {
      if (entry.status === "dirty" || line >= doc.lineCount) {
        continue;
      }
      const textLine = doc.lineAt(line);
      if (textLine.text !== entry.text) {
        continue;
      }
      const end = textLine.range.end;
      const range = new vscode.Range(end, end);
      if (entry.status === "pending") {
        options.push({
          range,
          renderOptions: { after: { contentText: "…", color: new vscode.ThemeColor("editorCodeLens.foreground") } },
        });
      } else {
        options.push({
          range,
          hoverMessage: new vscode.MarkdownString(
            `**Jev** answered **${entry.thumbsUp ? "yes" : "no"}** to “${entry.prompt}” ` +
              `(p(yes) = ${entry.noul.toFixed(2)})`,
          ),
          renderOptions: { after: { contentText: entry.thumbsUp ? "👍" : "👎" } },
        });
      }
    }
  }
  editors.forEach((e) => e.setDecorations(decoration, options));
}
