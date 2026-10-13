# Jev's Code

A VS Code extension that asks [Jev](https://docs.typesafe.ai) a question about every line of code you write, then marks the line 👍 or 👎.

The default question is **"is this ok?"**

## How it works

- When you edit a line and then move the cursor off it (pressing Enter counts), the extension sends that line to Jev, along with a few surrounding lines for context.
- While Jev is answering, a `…` appears at the end of the line. When the answer comes back, it's replaced by 👍 (yes) or 👎 (no). Hover over the emoji to see the probability.
- If you edit the line again, its mark disappears until you finish the new version.
- Jev is asked a TypeSafe **Noul** (yes/no) question and returns the probability of "yes". A 👍 means that probability is at least `jev.threshold`.
- Blank lines are skipped. A multi-line paste only gets checked line by line as your cursor passes through it, so you don't send a request for every pasted line.

## Setup

1. Get a TypeSafe API key.
2. Run **Jev: Set TypeSafe API Key** from the Command Palette. The key goes in VS Code's secret storage. If you don't set one, the extension uses the `TYPESAFE_API_KEY` environment variable.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `jev.prompt` | `"is this ok?"` | The yes/no question Jev answers about each line |
| `jev.threshold` | `0.5` | Minimum p(yes) needed for a 👍 |
| `jev.contextLines` | `5` | Number of lines before and after the line that are sent as context |
| `jev.model` | `"jev-latest"` | TypeSafe model |
| `jev.enabled` | `true` | Turns automatic checks on or off (you can also click `Jev 👍` in the status bar) |

## Commands

- **Jev: Set TypeSafe API Key**
- **Jev: Toggle Line Checks**
- **Jev: Evaluate Current Line**: check the current line now
- **Jev: Clear Verdicts**

The **Jev** output channel logs every verdict, plus any errors.

## Development

```sh
npm install
npm run compile
```

Press F5 in VS Code to open an Extension Development Host. To build a `.vsix`, run `npm run package`, then install it with `code --install-extension jev-s-code-0.1.0.vsix`.
