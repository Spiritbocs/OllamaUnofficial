# Contributing to OllamaUnofficial

Thanks for your interest in contributing! This document covers everything you need to know to get set up, make changes, and package a release.

---

## Project Overview

OllamaUnofficial is a VS Code extension built with TypeScript. The codebase is intentionally small and dependency-light. Here is the high-level layout:

```
OllamaUnofficial/
├── src/
│   ├── extension.ts          # Main extension entry point + webview HTML template
│   ├── chatSessions.ts       # Session persistence (tabs, history)
│   ├── secrets.ts            # Secret key names for VS Code Secret Storage
│   └── llm/
│       ├── ollamaStream.ts   # Ollama streaming client
│       └── openaiSseStream.ts  # OpenAI-compatible SSE streaming (OpenRouter, HF)
├── src/webview/
│   └── chat.ts               # All browser-side logic for the chat UI
├── media/
│   ├── chat.css              # Styles for the webview
│   └── icon.svg              # Sidebar activity bar icon
├── dist/                     # Compiled output (generated, do not edit)
├── release/                  # Packaged .vsix files
├── esbuild.mjs               # Build script
├── tsconfig.json             # TypeScript config
└── package.json              # Extension manifest and scripts
```

The extension host side (`extension.ts`) manages VS Code APIs, provider switching, sessions, and settings. The webview side (`chat.ts` and `chat.css`) is a standalone browser context that communicates with the host via `postMessage`.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- [npm](https://npmjs.com/) (comes with Node)
- [VS Code](https://code.visualstudio.com/) for running and testing the extension

---

## Setup

Clone the repo and install dependencies:

```bash
git clone <your-repo-url>
cd OllamaUnofficial
npm install
```

This installs TypeScript, esbuild, and the VS Code type definitions needed to compile the extension.

---

## Building

There is a single build script that compiles both the extension host and the webview bundle:

```bash
npm run build
```

This runs `esbuild.mjs` and outputs compiled files to `dist/`. The build is fast (usually under a second).

To rebuild automatically whenever you save a file:

```bash
npm run watch
```

---

## Running in Development

1. Open the project folder in VS Code.
2. Press `F5` to launch the **Extension Development Host** — a second VS Code window with your extension loaded.
3. In that window, open the Activity Bar and click the OllamaUnofficial icon.
4. Make changes to the source, run `npm run build`, and reload the Extension Development Host window (`Ctrl+R`) to see them.

The `launch.json` in `.vscode/` is already configured for this workflow.

---

## Code Structure in Detail

### `src/extension.ts`

This is the entry point. It registers the webview view provider and all commands. The class `OllamaCoderChatViewProvider` handles:

- Rendering the full HTML/CSS/JS webview
- Receiving messages from the webview (`panel.webview.onDidReceiveMessage`)
- Posting messages back to the webview
- Streaming from Ollama, OpenRouter, and Hugging Face
- Managing sessions and persisting chat history to VS Code global state
- Storing and retrieving API keys via VS Code Secret Storage

The HTML for the webview is returned by `getHtmlForWebview()` as a template literal. Styles are loaded from `media/chat.css` via a webview URI.

### `src/webview/chat.ts`

All UI logic runs here. This file is compiled by esbuild into `dist/chat.js` and injected into the webview at runtime. It:

- Listens for messages from the extension host via `window.addEventListener('message', ...)`
- Sends messages to the host via `vscode.postMessage(...)`
- Manages the DOM: chat bubbles, session tabs, attachment chips, the settings panel, mode selector, and the attach menu
- Renders AI responses as Markdown using `marked` and sanitises output with `DOMPurify`

### `media/chat.css`

All styles for the webview. The CSS uses VS Code theme tokens (e.g. `--vscode-foreground`, `--vscode-input-background`) so the UI automatically adapts to whatever theme the user has installed — dark, light, or high contrast.

### `src/llm/`

Two streaming clients:

- `ollamaStream.ts` — streams from the Ollama `/api/chat` endpoint (NDJSON format)
- `openaiSseStream.ts` — streams from any OpenAI-compatible `/v1/chat/completions` endpoint (Server-Sent Events), used for both OpenRouter and Hugging Face

---

## Message Protocol

The extension host and the webview communicate using a typed message bus. Here are the key message types:

**Webview → Host**

| Type | Purpose |
|---|---|
| `send` | User submits a chat message |
| `getModels` | Request the model list for the current provider |
| `getSettings` | Request settings to populate the settings panel |
| `saveSettings` | Save new API keys and sampling parameters |
| `setProvider` | Switch the active provider |
| `setModel` | Switch the active model |
| `newSession` | Open a new chat tab |
| `switchSession` | Switch to an existing tab |
| `closeSession` | Close a tab |
| `renameSession` | Rename a tab |
| `attachActiveFile` | Attach the currently open file |
| `pickOpenEditor` | Pick from open editor tabs |
| `pickWorkspaceFile` | Browse the workspace for a file |
| `attachProblems` | Attach diagnostics from the active file |
| `attachClipboardImage` | Attach an image from clipboard |
| `removeAttachment` | Remove a previously added attachment |

**Host → Webview**

| Type | Purpose |
|---|---|
| `status` | Update the status indicator (Idle, Thinking, Error…) |
| `models` | Send the model list |
| `modelChanged` | Notify that the active model changed |
| `providerChanged` | Notify that the active provider changed |
| `settingsForm` | Send settings data to populate the settings panel |
| `sessionState` | Send the full list of sessions and the active session ID |
| `loadThread` | Load a full chat history into the message area |
| `cleared` | Clear the message area (new session) |
| `assistantStart` | Streaming started — show a loading bubble |
| `assistantDelta` | Streaming chunk — update the bubble text |
| `assistantDone` | Streaming complete — render final Markdown |
| `assistantAbort` | Stream was cancelled |
| `assistantError` | Stream errored — show error bubble |
| `attachmentsUpdated` | Update the attachment chip row |

---

## Packaging a Release

To build a `.vsix` installer file:

```bash
# Make sure you have vsce available
npm install -g @vscode/vsce

# Build the extension first
npm run build

# Package it
vsce package --out release/ollamaunofficial-<version>.vsix --no-dependencies
```

The resulting `.vsix` file in `release/` can be distributed and installed directly in VS Code via **Install from VSIX**.

Before packaging, bump the `version` field in `package.json` to match your release number.

---

## Adding a New Provider

1. Add the provider ID to the `ProviderId` type in `extension.ts`.
2. Add a streaming/request function in `src/llm/`.
3. Add a case in `streamFromProvider()` in `extension.ts` to call your new function.
4. Add a `<option>` to the `providerSelect` dropdown in `getHtmlForWebview()`.
5. Handle any new settings fields in `handleGetSettings()` and `handleSaveSettings()`.

---

## Style Guide

- TypeScript strict mode is enabled. No `any` unless absolutely necessary.
- The webview has no framework — plain DOM APIs only. Keep it that way.
- CSS uses VS Code theme tokens for all colours. Do not hardcode colour values except as fallbacks.
- All user-visible strings in the HTML live in `extension.ts` (the template literal). The webview JS does not generate user-visible text directly, except for dynamic content like role labels ("You", "Assistant").

---

## Reporting Issues

If something is broken or you have a feature idea, open an issue with:

- What you expected to happen
- What actually happened
- Your OS, VS Code version, and which provider you were using
- Any relevant output from **OllamaUnofficial: Show Log**

---

## License

MIT. By contributing you agree that your changes will be released under the same license.
