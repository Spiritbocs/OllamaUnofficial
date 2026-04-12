"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));
var import_child_process = require("child_process");
var fs2 = __toESM(require("fs"));
var nodePath2 = __toESM(require("path"));

// src/chatSessions.ts
var SESSIONS_KEY = "ollamaCoderChat.sessions.v2";
var ACTIVE_KEY = "ollamaCoderChat.activeSessionId.v2";
var MAX_SESSIONS = 24;
function randomId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
function truncateTitle(text, max = 40) {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one || "New chat";
  }
  return `${one.slice(0, max - 1)}\u2026`;
}
function loadSessions(globalState) {
  try {
    const raw = globalState.get(SESSIONS_KEY);
    const sessions = raw ? JSON.parse(raw).filter(
      (s) => s && typeof s.id === "string" && Array.isArray(s.messages)
    ) : [];
    let activeSessionId = globalState.get(ACTIVE_KEY) ?? "";
    if (!sessions.length) {
      const id = randomId();
      sessions.push({ id, title: "New chat", updatedAt: Date.now(), messages: [] });
      activeSessionId = id;
    }
    if (!sessions.some((s) => s.id === activeSessionId)) {
      activeSessionId = sessions[0]?.id ?? "";
    }
    return { sessions, activeSessionId };
  } catch {
    const id = randomId();
    return {
      sessions: [{ id, title: "New chat", updatedAt: Date.now(), messages: [] }],
      activeSessionId: id
    };
  }
}
function saveSessions(globalState, sessions, activeSessionId) {
  const trimmed = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  return Promise.all([
    globalState.update(SESSIONS_KEY, JSON.stringify(trimmed)),
    globalState.update(ACTIVE_KEY, activeSessionId)
  ]).then(() => void 0);
}
function upsertSessionTitleFromMessages(session) {
  if (session.title !== "New chat") {
    return;
  }
  const firstUser = session.messages.find((m) => m.role === "user");
  if (firstUser?.content) {
    const head = firstUser.content.split("\n")[0] ?? firstUser.content;
    session.title = truncateTitle(head);
  }
}

// src/llm/ollamaStream.ts
function composeDisplay(textBuf, thinkingBuf, toolJson) {
  const thinkingBlock = thinkingBuf.trim().length > 0 ? `### Reasoning
${thinkingBuf.trim()}

### Answer
` : "";
  const toolBlock = toolJson && toolJson.length > 0 ? `

---

_Model output included tool calls (not executed by the extension):_

\`\`\`json
${toolJson}
\`\`\`
` : "";
  return `${thinkingBlock}${textBuf}${toolBlock}`;
}
async function streamOllamaChat(args) {
  const url = `${args.baseUrl.replace(/\/$/, "")}/api/chat`;
  const body = {
    model: args.model,
    stream: true,
    messages: args.messages,
    options: buildOllamaOptions(args)
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: args.signal,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText} ${errorText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Ollama returned an empty response body.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let textBuf = "";
  let thinkingBuf = "";
  let lastToolJson;
  const flush = () => {
    args.onDelta(composeDisplay(textBuf, thinkingBuf, lastToolJson));
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let data;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof data.error === "string") {
        throw new Error(data.error);
      }
      const message = data.message;
      if (!message) {
        continue;
      }
      if (typeof message.content === "string" && message.content.length > 0) {
        textBuf += message.content;
      }
      const thinking = message.thinking;
      if (typeof thinking === "string" && thinking.length > 0) {
        thinkingBuf += thinking;
      }
      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        try {
          lastToolJson = JSON.stringify(toolCalls, null, 2);
        } catch {
          lastToolJson = String(toolCalls);
        }
      }
      flush();
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      const data = JSON.parse(tail);
      if (typeof data.error === "string") {
        throw new Error(data.error);
      }
      const message = data.message;
      if (message) {
        if (typeof message.content === "string" && message.content.length > 0) {
          textBuf += message.content;
        }
        const thinking = message.thinking;
        if (typeof thinking === "string" && thinking.length > 0) {
          thinkingBuf += thinking;
        }
        const toolCalls = message.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          try {
            lastToolJson = JSON.stringify(toolCalls, null, 2);
          } catch {
            lastToolJson = String(toolCalls);
          }
        }
      }
    } catch {
    }
  }
  flush();
  const combined = composeDisplay(textBuf, thinkingBuf, lastToolJson).trim();
  if (combined.length > 0) {
    args.onDelta(combined);
    return combined;
  }
  return await ollamaChatNonStream({
    baseUrl: args.baseUrl,
    model: args.model,
    messages: args.messages,
    signal: args.signal,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    topP: args.topP
  });
}
function buildOllamaOptions(args) {
  const options = {};
  if (typeof args.temperature === "number" && !Number.isNaN(args.temperature)) {
    options.temperature = args.temperature;
  }
  if (typeof args.topP === "number" && !Number.isNaN(args.topP)) {
    options.top_p = args.topP;
  }
  if (typeof args.maxTokens === "number" && !Number.isNaN(args.maxTokens) && args.maxTokens > 0) {
    options.num_predict = Math.floor(args.maxTokens);
  }
  return Object.keys(options).length ? options : void 0;
}
async function ollamaChatNonStream(args) {
  const url = `${args.baseUrl.replace(/\/$/, "")}/api/chat`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      stream: false,
      messages: args.messages,
      options: buildOllamaOptions(args)
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} (non-stream fallback) ${errorText}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
  const msg = data.message;
  let text = msg?.content?.trim() ?? "";
  const thinking = typeof msg?.thinking === "string" ? msg.thinking : "";
  const toolCalls = msg?.tool_calls;
  if ((!text || text.length === 0) && Array.isArray(toolCalls) && toolCalls.length > 0) {
    text = `Tool calls (not executed):
\`\`\`json
${JSON.stringify(toolCalls, null, 2)}
\`\`\``;
  }
  if (thinking.trim().length > 0) {
    text = `### Reasoning
${thinking.trim()}

### Answer
${text}`;
  }
  if (!text.trim()) {
    throw new Error("Ollama returned an empty response (stream and non-stream).");
  }
  return text;
}

// src/llm/openaiSseStream.ts
async function streamOpenAiCompatibleChat(args) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
      Accept: "text/event-stream",
      ...args.extraHeaders
    },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: true,
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      top_p: args.topP
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText} ${errorText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Empty response body.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let textBuf = "";
  let reasoningBuf = "";
  const compose = () => {
    const r = reasoningBuf.trim();
    args.onDelta(
      r.length > 0 ? `### Reasoning
${r}

### Answer
${textBuf}` : textBuf
    );
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf("\n\n");
      const lines = rawEvent.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice("data:".length).trim();
        if (payload === "[DONE]") {
          compose();
          const out2 = (reasoningBuf.trim().length > 0 ? `### Reasoning
${reasoningBuf.trim()}

### Answer
${textBuf}` : textBuf).trim();
          if (!out2) {
            throw new Error("Model returned an empty streamed response.");
          }
          return reasoningBuf.trim().length > 0 ? `### Reasoning
${reasoningBuf.trim()}

### Answer
${textBuf}` : textBuf;
        }
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (typeof data.error === "string") {
          throw new Error(data.error);
        }
        if (typeof data.error === "object" && data.error !== null) {
          const err = data.error;
          throw new Error(err.message ?? JSON.stringify(data.error));
        }
        const choices = data.choices;
        const choice0 = choices?.[0];
        const delta = choice0?.delta;
        if (delta) {
          const c = delta.content;
          if (typeof c === "string" && c.length > 0) {
            textBuf += c;
          }
          const r = delta.reasoning ?? delta.reasoning_content;
          if (typeof r === "string" && r.length > 0) {
            reasoningBuf += r;
          }
        }
        compose();
      }
    }
  }
  compose();
  const out = (reasoningBuf.trim().length > 0 ? `### Reasoning
${reasoningBuf.trim()}

### Answer
${textBuf}` : textBuf).trim();
  if (!out) {
    throw new Error("Model returned an empty streamed response.");
  }
  return reasoningBuf.trim().length > 0 ? `### Reasoning
${reasoningBuf.trim()}

### Answer
${textBuf}` : textBuf;
}
async function openAiNonStream(args) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
      ...args.extraHeaders
    },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: false,
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      top_p: args.topP
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${errorText}`);
  }
  const data = await response.json();
  if (data.error?.message) {
    throw new Error(data.error.message);
  }
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("Empty non-stream response.");
  }
  return text;
}

// src/secrets.ts
var SECRET_OPENROUTER = "ollamaCoderChat.openrouterApiKey";
var SECRET_HUGGINGFACE = "ollamaCoderChat.huggingfaceApiKey";

// src/browserPanel.ts
var vscode = __toESM(require("vscode"));
var https = __toESM(require("https"));
var http = __toESM(require("http"));
var BrowserPanel = class _BrowserPanel {
  static instance;
  panel;
  chatPostMessage;
  constructor(context, chatPostMessage) {
    this.chatPostMessage = chatPostMessage;
    this.panel = vscode.window.createWebviewPanel(
      "ollamaUnofficial.browser",
      "\u{1F310} OllamaUnofficial Browser",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    this.panel.webview.html = _BrowserPanel.getHtml();
    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.type === "fetchPage") {
          await this.loadPage(msg.url);
        } else if (msg.type === "sendToChat") {
          if (this.chatPostMessage) {
            this.chatPostMessage({
              type: "browserSelection",
              text: msg.text,
              url: msg.url,
              elementTag: msg.elementTag
            });
          }
          void vscode.commands.executeCommand("ollamaCoderChat.sidebar.focus");
        }
      },
      void 0,
      context.subscriptions
    );
    this.panel.onDidDispose(() => {
      _BrowserPanel.instance = void 0;
    });
  }
  static createOrShow(context, chatPostMessage) {
    if (_BrowserPanel.instance) {
      _BrowserPanel.instance.chatPostMessage = chatPostMessage;
      _BrowserPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    _BrowserPanel.instance = new _BrowserPanel(context, chatPostMessage);
  }
  async loadPage(url) {
    try {
      const resolved = url.startsWith("http") ? url : `https://${url}`;
      const html = await _BrowserPanel.fetchUrl(resolved);
      void this.panel.webview.postMessage({ type: "pageLoaded", html, url: resolved });
    } catch (err) {
      void this.panel.webview.postMessage({
        type: "pageError",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  static fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
            "Accept-Language": "en-US,en;q=0.9"
          },
          timeout: 15e3
        },
        (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
            resolve(_BrowserPanel.fetchUrl(res.headers.location));
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out after 15s"));
      });
    });
  }
  static getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OllamaUnofficial Browser</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #cccccc);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--vscode-sideBar-background, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
}
#urlInput {
  flex: 1;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #cccccc);
  font-size: 12px;
  outline: none;
}
#urlInput:focus { border-color: var(--vscode-focusBorder, #007fd4); }
.nav-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.nav-btn:hover { opacity: 0.88; }
.nav-btn.secondary {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
}
#statusBar {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  background: var(--vscode-sideBar-background, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2));
  min-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#selectionBar {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 15%, var(--vscode-editor-background, #1e1e1e));
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-button-background, #0e639c) 40%, transparent);
  font-size: 12px;
}
#selectionBar.visible { display: flex; }
#selectionPreview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground, #ccc);
  font-style: italic;
  opacity: 0.85;
}
#sendToChat {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 14px;
  border-radius: 5px;
  border: none;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
#sendToChat:hover { opacity: 0.88; }
#clearSel {
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground, #888);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
#content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 18px;
  line-height: 1.6;
}
#loader {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  flex: 1;
  color: var(--vscode-descriptionForeground, #888);
}
#loader.visible { display: flex; }
.loader-ring {
  width: 32px; height: 32px;
  border: 3px solid rgba(127,127,127,0.2);
  border-top-color: var(--vscode-button-background, #0e639c);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
#welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  color: var(--vscode-descriptionForeground, #888);
  text-align: center;
}
#welcome h2 { font-size: 16px; color: var(--vscode-foreground, #ccc); margin-bottom: 4px; }
#welcome p { font-size: 12px; max-width: 320px; line-height: 1.6; }
.quick-links { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 10px; }
.quick-link {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
  background: none;
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer;
  font-size: 11px;
}
.quick-link:hover { background: var(--vscode-toolbar-hoverBackground); }
/* Rendered page content */
#pageRoot { max-width: 860px; }
#pageRoot .oui-highlight {
  background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 30%, transparent) !important;
  outline: 1px solid var(--vscode-button-background, #0e639c) !important;
  border-radius: 2px !important;
  cursor: pointer !important;
}
#pageRoot * { max-width: 100%; word-break: break-word; }
#pageRoot a { color: var(--vscode-textLink-foreground, #3794ff); }
#pageRoot h1, #pageRoot h2, #pageRoot h3, #pageRoot h4 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
}
#pageRoot h1 { font-size: 1.6em; }
#pageRoot h2 { font-size: 1.3em; }
#pageRoot h3 { font-size: 1.1em; }
#pageRoot p { margin: 0 0 0.7em; }
#pageRoot ul, #pageRoot ol { margin: 0 0 0.7em 1.4em; }
#pageRoot li { margin: 0.2em 0; }
#pageRoot pre, #pageRoot code {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  background: rgba(127,127,127,0.12);
  border-radius: 4px;
  padding: 2px 5px;
}
#pageRoot pre { padding: 10px 14px; overflow-x: auto; white-space: pre-wrap; }
#pageRoot pre code { background: none; padding: 0; }
#pageRoot table { border-collapse: collapse; margin-bottom: 0.7em; width: 100%; }
#pageRoot th, #pageRoot td { border: 1px solid rgba(127,127,127,0.25); padding: 5px 10px; text-align: left; }
#pageRoot th { background: rgba(127,127,127,0.1); font-weight: 600; }
#pageRoot blockquote {
  border-left: 3px solid rgba(127,127,127,0.35);
  padding-left: 12px;
  margin: 0 0 0.7em;
  color: var(--vscode-descriptionForeground);
}
#pageRoot img { max-width: 100%; height: auto; border-radius: 4px; }
#error {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  color: var(--vscode-errorForeground, #f85149);
  text-align: center;
}
#error.visible { display: flex; }
#error p { font-size: 12px; color: var(--vscode-descriptionForeground); max-width: 360px; }
</style>
</head>
<body>
<div id="toolbar">
  <button class="nav-btn secondary" id="backBtn" title="Back">\u25C0</button>
  <input id="urlInput" type="text" placeholder="Enter a URL, e.g. https://example.com" spellcheck="false"/>
  <button class="nav-btn" id="goBtn">Go</button>
</div>
<div id="statusBar">Enter a URL above and press Go</div>
<div id="selectionBar">
  <span>Selected:</span>
  <span id="selectionPreview"></span>
  <button id="sendToChat">Send to Chat \u2192</button>
  <button id="clearSel" title="Clear selection">\xD7</button>
</div>
<div id="loader"><div class="loader-ring"></div><span>Loading page\u2026</span></div>
<div id="error"><b>Could not load page</b><p id="errorMsg"></p></div>
<div id="content">
  <div id="welcome">
    <h2>\u{1F310} Browse & Select</h2>
    <p>Navigate to any webpage, then select text or click on elements to send them to OllamaUnofficial chat.</p>
    <div class="quick-links">
      <button class="quick-link" data-url="https://docs.python.org/3/">Python Docs</button>
      <button class="quick-link" data-url="https://developer.mozilla.org/en-US/docs/Web/JavaScript">MDN JS</button>
      <button class="quick-link" data-url="https://github.com">GitHub</button>
      <button class="quick-link" data-url="https://stackoverflow.com">Stack Overflow</button>
      <button class="quick-link" data-url="https://news.ycombinator.com">Hacker News</button>
    </div>
  </div>
  <div id="pageRoot" style="display:none"></div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const urlInput = document.getElementById('urlInput');
  const goBtn = document.getElementById('goBtn');
  const backBtn = document.getElementById('backBtn');
  const statusBar = document.getElementById('statusBar');
  const selectionBar = document.getElementById('selectionBar');
  const selectionPreview = document.getElementById('selectionPreview');
  const sendToChat = document.getElementById('sendToChat');
  const clearSel = document.getElementById('clearSel');
  const content = document.getElementById('content');
  const loader = document.getElementById('loader');
  const errorEl = document.getElementById('error');
  const errorMsg = document.getElementById('errorMsg');
  const welcome = document.getElementById('welcome');
  const pageRoot = document.getElementById('pageRoot');

  let currentUrl = '';
  let history = [];
  let selectedText = '';
  let selectedTag = '';

  function setLoading(on) {
    loader.classList.toggle('visible', on);
    content.style.display = on ? 'none' : '';
    errorEl.classList.remove('visible');
  }

  function showError(msg) {
    loader.classList.remove('visible');
    content.style.display = '';
    welcome.style.display = 'none';
    pageRoot.style.display = 'none';
    errorEl.classList.add('visible');
    document.getElementById('errorMsg').textContent = msg;
  }

  function navigate(url) {
    if (!url) return;
    const resolved = url.startsWith('http') ? url : 'https://' + url;
    urlInput.value = resolved;
    statusBar.textContent = 'Loading ' + resolved + '\u2026';
    setLoading(true);
    clearSelection();
    vscode.postMessage({ type: 'fetchPage', url: resolved });
  }

  function clearSelection() {
    selectedText = '';
    selectedTag = '';
    selectionBar.classList.remove('visible');
    selectionPreview.textContent = '';
    document.querySelectorAll('.oui-highlight').forEach(el => el.classList.remove('oui-highlight'));
    window.getSelection()?.removeAllRanges();
  }

  function showSelection(text, tag) {
    if (!text || text.length < 2) return;
    selectedText = text.trim();
    selectedTag = tag || '';
    const preview = selectedText.length > 120 ? selectedText.slice(0, 120) + '\u2026' : selectedText;
    selectionPreview.textContent = '"' + preview + '"';
    selectionBar.classList.add('visible');
  }

  // Go button
  goBtn.addEventListener('click', () => navigate(urlInput.value.trim()));
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(urlInput.value.trim());
  });
  backBtn.addEventListener('click', () => {
    if (history.length > 1) {
      history.pop();
      navigate(history.pop());
    }
  });

  // Quick links
  document.querySelectorAll('.quick-link').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.url));
  });

  // Text selection
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (text.length > 1 && pageRoot.contains(sel?.anchorNode)) {
      showSelection(text, '');
    } else if (!text) {
      // Don't clear if we had a click-selected element
    }
  });

  // Element click picking (Ctrl+Click or just click on elements)
  pageRoot.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || target === pageRoot) return;

    // Intercept link clicks
    if (target.tagName === 'A' || target.closest('a')) {
      e.preventDefault();
      const a = target.tagName === 'A' ? target : target.closest('a');
      const href = a.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        let resolved = href;
        if (href.startsWith('/') && currentUrl) {
          try {
            const u = new URL(currentUrl);
            resolved = u.origin + href;
          } catch {}
        } else if (!href.startsWith('http')) {
          try {
            resolved = new URL(href, currentUrl).href;
          } catch {}
        }
        navigate(resolved);
        return;
      }
    }

    // Alt+Click to select element
    if (e.altKey) {
      e.preventDefault();
      document.querySelectorAll('.oui-highlight').forEach(el => el.classList.remove('oui-highlight'));
      target.classList.add('oui-highlight');
      const text = target.innerText || target.textContent || '';
      showSelection(text, target.tagName.toLowerCase());
    }
  });

  // Hover highlight hint for alt+click
  pageRoot.addEventListener('mouseover', (e) => {
    if (!e.altKey) return;
    const target = e.target;
    if (target && target !== pageRoot) {
      document.querySelectorAll('.oui-hover').forEach(el => el.classList.remove('oui-hover'));
      target.style.outline = '1px dashed rgba(127,127,127,0.5)';
      target.addEventListener('mouseleave', () => { target.style.outline = ''; }, { once: true });
    }
  });

  // Send to chat
  sendToChat.addEventListener('click', () => {
    if (selectedText) {
      vscode.postMessage({ type: 'sendToChat', text: selectedText, url: currentUrl, elementTag: selectedTag });
      statusBar.textContent = '\u2713 Sent to chat! Selection: "' + (selectedText.length > 60 ? selectedText.slice(0,60)+'\u2026' : selectedText) + '"';
      clearSelection();
    }
  });
  clearSel.addEventListener('click', clearSelection);

  // Receive messages from extension
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'pageLoaded') {
      currentUrl = msg.url;
      history.push(msg.url);
      urlInput.value = msg.url;
      statusBar.textContent = '\u2713 Loaded: ' + msg.url + '  |  Alt+Click to pick an element, or select text';

      // Parse and render the HTML
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(msg.html, 'text/html');

        // Remove scripts, style links, noscript, etc.
        doc.querySelectorAll('script, noscript, iframe, object, embed, form input[type=hidden]').forEach(el => el.remove());

        // Try to get main content area
        const main = doc.querySelector('main, article, [role=main], #main, #content, .content, .main') || doc.body;

        // Remove nav, footer, aside if we found main content
        if (main !== doc.body) {
          doc.querySelectorAll('nav, footer, aside, .nav, .footer, .sidebar, header').forEach(el => el.remove());
        }

        pageRoot.innerHTML = (main || doc.body).innerHTML;

        // Remove all event handlers from parsed content (security)
        pageRoot.querySelectorAll('*').forEach(el => {
          // Remove on* attributes
          Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
          });
        });

        // Fix relative image srcs (just remove broken images)
        pageRoot.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('src') || '';
          if (!src.startsWith('http') && !src.startsWith('data:')) {
            try {
              img.src = new URL(src, currentUrl).href;
            } catch {
              img.remove();
            }
          }
        });

      } catch (err) {
        pageRoot.textContent = 'Could not render page content.';
      }

      setLoading(false);
      welcome.style.display = 'none';
      pageRoot.style.display = '';
      errorEl.classList.remove('visible');

    } else if (msg.type === 'pageError') {
      showError(msg.error + '\\n\\nNote: Some sites block automated access. Try a different URL or check your connection.');
    }
  });
})();
</script>
</body>
</html>`;
  }
};

// src/progressPanel.ts
var ProgressViewProvider = class _ProgressViewProvider {
  static viewType = "ollamaCoderChat.progress";
  view;
  steps = [];
  idleLabel = "Ready";
  resolveWebviewView(webviewView, _context, _token) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = _ProgressViewProvider.getHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        this.flush();
      }
    });
  }
  /** Replace all steps at once */
  setSteps(steps) {
    this.steps = steps;
    this.flush();
  }
  /** Mark a single step by index as active (sets all previous to done) */
  activateStep(index, detail) {
    this.steps = this.steps.map((s, i) => ({
      ...s,
      status: i < index ? "done" : i === index ? "active" : "pending",
      detail: i === index ? detail ?? s.detail : s.detail
    }));
    this.flush();
  }
  /** Mark a single step done */
  completeStep(index) {
    if (this.steps[index]) {
      this.steps[index] = { ...this.steps[index], status: "done" };
      this.flush();
    }
  }
  /** Mark a step errored */
  errorStep(index, detail) {
    if (this.steps[index]) {
      this.steps[index] = { ...this.steps[index], status: "error", detail };
      this.flush();
    }
  }
  /** Mark all steps done */
  allDone() {
    this.steps = this.steps.map((s) => ({ ...s, status: "done" }));
    this.flush();
  }
  /** Clear back to idle */
  clear() {
    this.steps = [];
    this.flush();
  }
  flush() {
    if (this.view?.visible) {
      void this.view.webview.postMessage({
        type: "update",
        steps: this.steps,
        idle: this.idleLabel
      });
    }
  }
  static getHtml() {
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--vscode-font-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: 12px;
  background: transparent;
  color: var(--vscode-foreground, #cccccc);
  padding: 10px 12px 14px;
  min-height: 100%;
}

#idle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground, #888);
  font-size: 12px;
  padding: 4px 0;
}

.idle-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground, #666);
  opacity: 0.5;
}

#steps {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
  position: relative;
  transition: opacity 0.2s;
}

/* Connector line between steps */
.step:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 11px;
  top: 26px;
  bottom: -7px;
  width: 1px;
  background: var(--vscode-widget-border, rgba(127,127,127,0.25));
}

.step.status-done:not(:last-child)::after {
  background: color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 50%, transparent);
}

/* Number / status indicator */
.step-indicator {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  margin-top: 1px;
  position: relative;
  z-index: 1;
}

.status-pending .step-indicator {
  border: 1.5px solid var(--vscode-widget-border, rgba(127,127,127,0.4));
  color: var(--vscode-descriptionForeground, #888);
  background: var(--vscode-sideBar-background, #1e1e1e);
}

.status-active .step-indicator {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-button-background, #0e639c) 25%, transparent);
  animation: pulse 1.8s ease-in-out infinite;
}

.status-done .step-indicator {
  background: color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 18%, transparent);
  border: 1.5px solid color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 60%, transparent);
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.status-error .step-indicator {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 15%, transparent);
  border: 1.5px solid color-mix(in srgb, var(--vscode-errorForeground, #f85149) 50%, transparent);
  color: var(--vscode-errorForeground, #f85149);
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-button-background, #0e639c) 25%, transparent); }
  50%       { box-shadow: 0 0 0 5px color-mix(in srgb, var(--vscode-button-background, #0e639c) 10%, transparent); }
}

.step-body {
  flex: 1;
  min-width: 0;
  padding-top: 2px;
}

.step-label {
  line-height: 1.4;
  word-break: break-word;
}

.status-pending .step-label {
  color: var(--vscode-descriptionForeground, #888);
}

.status-active .step-label {
  color: var(--vscode-foreground, #ccc);
  font-weight: 600;
}

.status-done .step-label {
  color: var(--vscode-descriptionForeground, #888);
}

.status-error .step-label {
  color: var(--vscode-errorForeground, #f85149);
}

.step-detail {
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground, #777);
  margin-top: 2px;
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* Animated dots for active step */
.active-dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 4px;
  vertical-align: middle;
}

.active-dots span {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--vscode-button-background, #0e639c);
  animation: bounce 1.2s ease-in-out infinite;
  display: inline-block;
}

.active-dots span:nth-child(2) { animation-delay: 0.2s; }
.active-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40%            { transform: translateY(-3px); opacity: 1; }
}

.step-enter {
  animation: stepIn 0.2s ease-out both;
}

@keyframes stepIn {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
</style>
</head>
<body>
<div id="idle"><div class="idle-dot"></div><span>Ready</span></div>
<div id="steps" style="display:none"></div>

<script>
(function () {
  const vscode = acquireVsCodeApi();
  const idleEl = document.getElementById('idle');
  const stepsEl = document.getElementById('steps');

  const ICONS = { done: '\u2713', error: '\u2715' };

  function render(steps, idleLabel) {
    if (!steps || !steps.length) {
      idleEl.style.display = 'flex';
      idleEl.querySelector('span').textContent = idleLabel || 'Ready';
      stepsEl.style.display = 'none';
      stepsEl.innerHTML = '';
      return;
    }
    idleEl.style.display = 'none';
    stepsEl.style.display = 'flex';

    const prevCount = stepsEl.children.length;
    stepsEl.innerHTML = '';

    steps.forEach((step, i) => {
      const div = document.createElement('div');
      div.className = 'step status-' + step.status + (i >= prevCount ? ' step-enter' : '');

      const indicator = document.createElement('div');
      indicator.className = 'step-indicator';
      if (step.status === 'done') indicator.textContent = ICONS.done;
      else if (step.status === 'error') indicator.textContent = ICONS.error;
      else indicator.textContent = String(i + 1);

      const body = document.createElement('div');
      body.className = 'step-body';

      const label = document.createElement('div');
      label.className = 'step-label';
      label.textContent = step.label;

      if (step.status === 'active') {
        const dots = document.createElement('span');
        dots.className = 'active-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';
        label.appendChild(dots);
      }

      body.appendChild(label);

      if (step.detail) {
        const detail = document.createElement('div');
        detail.className = 'step-detail';
        detail.textContent = step.detail;
        body.appendChild(detail);
      }

      div.appendChild(indicator);
      div.appendChild(body);
      stepsEl.appendChild(div);
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'update') render(msg.steps, msg.idle);
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`
    );
  }
};

// src/updater.ts
var vscode2 = __toESM(require("vscode"));
var https2 = __toESM(require("https"));
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var nodePath = __toESM(require("path"));
var RELEASES_API = "https://api.github.com/repos/Spiritbocs/OllamaUnofficial/releases/latest";
var RELEASES_PAGE = "https://github.com/Spiritbocs/OllamaUnofficial/releases";
var USER_AGENT = "OllamaUnofficial-UpdateChecker/1.0";
function isNewer(a, b) {
  const parse = (v) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
function fetchJson(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https2.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 1e4 }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && redirects > 0) {
        resolve(fetchJson(res.headers.location, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode ?? "unknown"}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}
function downloadFile(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https2.get(
      url,
      { headers: { "User-Agent": USER_AGENT }, timeout: 6e4 },
      (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && redirects > 0) {
          resolve(downloadFile(res.headers.location, destPath, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode ?? "unknown"}`));
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          fs.unlink(destPath, () => void 0);
          reject(err);
        });
        res.on("error", (err) => {
          fs.unlink(destPath, () => void 0);
          reject(err);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Download timed out"));
    });
  });
}
async function installUpdate(downloadUrl, filename, log) {
  const tmpPath = nodePath.join(os.tmpdir(), filename);
  log.appendLine(`[updater] Downloading ${downloadUrl} \u2192 ${tmpPath}`);
  await vscode2.window.withProgress(
    {
      location: vscode2.ProgressLocation.Notification,
      title: `Downloading OllamaUnofficial ${filename}\u2026`,
      cancellable: false
    },
    async () => {
      await downloadFile(downloadUrl, tmpPath);
    }
  );
  log.appendLine("[updater] Download complete. Installing\u2026");
  try {
    await vscode2.commands.executeCommand(
      "workbench.extensions.installExtension",
      vscode2.Uri.file(tmpPath)
    );
  } finally {
    setTimeout(() => {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
      }
    }, 5e3);
  }
  const reload = await vscode2.window.showInformationMessage(
    "\u2705 OllamaUnofficial updated! Reload VS Code to apply the new version.",
    "Reload Now",
    "Later"
  );
  if (reload === "Reload Now") {
    await vscode2.commands.executeCommand("workbench.action.reloadWindow");
  }
}
function checkForUpdates(context, log) {
  log.appendLine("[updater] Update check scheduled (8s delay).");
  setTimeout(() => {
    void (async () => {
      try {
        log.appendLine("[updater] Starting update check\u2026");
        const ext = vscode2.extensions.getExtension("Spiritbocs.ollamaunofficial") ?? vscode2.extensions.getExtension("undefined_publisher.ollamaunofficial");
        const currentVersion = ext?.packageJSON?.["version"] ?? "0.0.0";
        log.appendLine(`[updater] Current version: ${currentVersion}`);
        const data = await fetchJson(RELEASES_API);
        const latestTag = data.tag_name ?? "";
        const latestVersion = latestTag.replace(/^v/, "");
        if (!latestVersion) {
          log.appendLine("[updater] Could not parse latest version from GitHub.");
          return;
        }
        log.appendLine(`[updater] Latest on GitHub: ${latestTag}`);
        if (!isNewer(latestVersion, currentVersion)) {
          log.appendLine("[updater] Already up to date.");
          return;
        }
        const vsixAsset = data.assets?.find((a) => a.name.endsWith(".vsix"));
        log.appendLine(`[updater] Update available: v${currentVersion} \u2192 ${latestTag}`);
        const choice = await vscode2.window.showInformationMessage(
          `\u{1F680} OllamaUnofficial ${latestTag} is available! (you have v${currentVersion})`,
          "Install Now",
          "View Release",
          "Later"
        );
        if (choice === "Install Now") {
          if (!vsixAsset) {
            void vscode2.window.showWarningMessage("Could not find the .vsix file in the release. Opening the release page instead.");
            void vscode2.env.openExternal(vscode2.Uri.parse(data.html_url ?? RELEASES_PAGE));
            return;
          }
          await installUpdate(vsixAsset.browser_download_url, vsixAsset.name, log);
        } else if (choice === "View Release") {
          void vscode2.env.openExternal(vscode2.Uri.parse(data.html_url ?? RELEASES_PAGE));
        }
      } catch (err) {
        log.appendLine(`[updater] Check skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, 8e3);
}

// src/extension.ts
var HF_SUGGESTED_MODELS = [
  "Qwen/Qwen2.5-Coder-7B-Instruct",
  "Qwen/Qwen2.5-7B-Instruct",
  "meta-llama/Llama-3.2-3B-Instruct",
  "HuggingFaceTB/SmolLM2-1.7B-Instruct",
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B"
];
var OllamaCoderChatViewProvider = class _OllamaCoderChatViewProvider {
  constructor(context) {
    this.context = context;
    this.log = vscode3.window.createOutputChannel("OllamaUnofficial");
    context.subscriptions.push(this.log);
    const loaded = loadSessions(this.context.globalState);
    this.sessions = loaded.sessions;
    this.activeSessionId = loaded.activeSessionId;
    this.messages = this.getActiveSession()?.messages.map((m) => ({ ...m })) ?? [];
  }
  static viewType = "ollamaCoderChat.sidebar";
  static maxAttachChars = 28e3;
  static maxTotalAttach = 96e3;
  webviewView;
  messages = [];
  abortController;
  requestGeneration = 0;
  attachments = [];
  nextAttachmentId = 1;
  sessions = [];
  activeSessionId = "";
  log;
  ollamaTerminal;
  progressProvider;
  setProgressProvider(p) {
    this.progressProvider = p;
  }
  getLog() {
    return this.log;
  }
  getActiveSession() {
    return this.sessions.find((s) => s.id === this.activeSessionId);
  }
  flushMessagesToActiveSession() {
    const session = this.getActiveSession();
    if (!session) {
      return;
    }
    session.messages = this.messages.map((m) => ({ ...m }));
    session.updatedAt = Date.now();
    upsertSessionTitleFromMessages(session);
    void saveSessions(this.context.globalState, this.sessions, this.activeSessionId);
  }
  showLog() {
    this.log.show(true);
  }
  async persistAllSessions() {
    await saveSessions(this.context.globalState, this.sessions, this.activeSessionId);
  }
  createNewSession() {
    this.requestGeneration += 1;
    this.abortController?.abort();
    this.abortController = void 0;
    this.flushMessagesToActiveSession();
    const id = randomId();
    this.sessions.push({ id, title: "New chat", updatedAt: Date.now(), messages: [] });
    this.activeSessionId = id;
    this.messages = [];
    this.attachments = [];
    this.postAttachments();
    void this.persistAllSessions();
    this.postMessage({ type: "cleared" });
    this.postSessionState();
    this.postMessage({ type: "status", status: "Idle" });
  }
  /** Legacy: treat as new session (tab) */
  clearChat() {
    this.createNewSession();
  }
  switchSession(id) {
    if (id === this.activeSessionId) {
      return;
    }
    const next = this.sessions.find((s) => s.id === id);
    if (!next) {
      return;
    }
    this.requestGeneration += 1;
    this.abortController?.abort();
    this.abortController = void 0;
    this.flushMessagesToActiveSession();
    this.activeSessionId = id;
    this.messages = next.messages.map((m) => ({ ...m }));
    this.attachments = [];
    this.postAttachments();
    void this.persistAllSessions();
    this.postThreadSnapshot();
    this.postSessionState();
    this.postMessage({ type: "status", status: "Idle" });
  }
  closeSession(id) {
    if (this.sessions.length <= 1) {
      void vscode3.window.showInformationMessage("Keep at least one chat tab.");
      return;
    }
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) {
      return;
    }
    this.requestGeneration += 1;
    this.abortController?.abort();
    this.abortController = void 0;
    if (id === this.activeSessionId) {
      this.flushMessagesToActiveSession();
    }
    this.sessions.splice(idx, 1);
    if (id === this.activeSessionId) {
      const fallback = this.sessions[Math.max(0, idx - 1)] ?? this.sessions[0];
      this.activeSessionId = fallback.id;
      this.messages = fallback.messages.map((m) => ({ ...m }));
      this.attachments = [];
      this.postAttachments();
      this.postThreadSnapshot();
    }
    void this.persistAllSessions();
    this.postSessionState();
  }
  resolveWebviewView(webviewView, _resolveContext, _token) {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode3.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode3.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        try {
          await this.handleWebviewMessage(message);
        } catch (error) {
          const text = error instanceof Error ? error.message : "Unexpected error in extension host.";
          this.log.appendLine(`[error] ${text}`);
          void vscode3.window.showErrorMessage(`OllamaUnofficial: ${text}`);
        }
      },
      void 0,
      this.context.subscriptions
    );
    webviewView.webview.html = this.getHtml(webviewView.webview);
    void this.refreshModelList();
    this.postAttachments();
    this.postSessionState();
    this.postThreadSnapshot();
  }
  postSessionState() {
    this.postMessage({
      type: "sessionState",
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt
      })),
      provider: this.getProvider()
    });
  }
  postThreadSnapshot() {
    this.postMessage({
      type: "loadThread",
      messages: this.messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
    });
  }
  async postSettingsSnapshot() {
    const c = vscode3.workspace.getConfiguration("ollamaCoderChat");
    const [openRouterKey, huggingfaceKey] = await Promise.all([
      this.context.secrets.get(SECRET_OPENROUTER),
      this.context.secrets.get(SECRET_HUGGINGFACE)
    ]);
    this.postMessage({
      type: "settingsForm",
      hasOpenRouterKey: Boolean(openRouterKey?.length),
      hasHuggingfaceKey: Boolean(huggingfaceKey?.length),
      temperature: c.get("temperature") ?? 0.2,
      maxTokens: c.get("maxTokens") ?? 4096,
      topP: c.get("topP") ?? 1,
      openRouterFreeOnly: c.get("openRouterFreeOnly") ?? true,
      fileAccess: c.get("fileAccess") ?? "none",
      fileScope: c.get("fileScope") ?? "workspace",
      terminalAccess: c.get("terminalAccess") ?? false,
      gitAccess: c.get("gitAccess") ?? false
    });
  }
  async saveSettingsFromWebview(message) {
    if (message.openRouterKey?.trim()) {
      await this.context.secrets.store(SECRET_OPENROUTER, message.openRouterKey.trim());
    }
    if (message.huggingfaceKey?.trim()) {
      await this.context.secrets.store(SECRET_HUGGINGFACE, message.huggingfaceKey.trim());
    }
    const config = vscode3.workspace.getConfiguration("ollamaCoderChat");
    if (typeof message.temperature === "number" && Number.isFinite(message.temperature)) {
      await config.update(
        "temperature",
        Math.min(2, Math.max(0, message.temperature)),
        vscode3.ConfigurationTarget.Global
      );
    }
    if (typeof message.maxTokens === "number" && Number.isFinite(message.maxTokens)) {
      await config.update(
        "maxTokens",
        Math.min(128e3, Math.max(1, Math.floor(message.maxTokens))),
        vscode3.ConfigurationTarget.Global
      );
    }
    if (typeof message.topP === "number" && Number.isFinite(message.topP)) {
      await config.update(
        "topP",
        Math.min(1, Math.max(0.01, message.topP)),
        vscode3.ConfigurationTarget.Global
      );
    }
    if (typeof message.openRouterFreeOnly === "boolean") {
      await config.update(
        "openRouterFreeOnly",
        message.openRouterFreeOnly,
        vscode3.ConfigurationTarget.Global
      );
    }
    if (typeof message.terminalAccess === "boolean") {
      await config.update("terminalAccess", message.terminalAccess, vscode3.ConfigurationTarget.Global);
    }
    if (typeof message.gitAccess === "boolean") {
      await config.update("gitAccess", message.gitAccess, vscode3.ConfigurationTarget.Global);
    }
    await this.refreshModelList();
    void vscode3.window.showInformationMessage("OllamaUnofficial: settings saved.");
  }
  async renameSessionById(id) {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    const next = await vscode3.window.showInputBox({
      title: "Rename chat tab",
      value: session.title,
      validateInput: (value) => value.trim().length > 0 ? void 0 : "Enter a name"
    });
    if (next === void 0) {
      return;
    }
    const trimmed = next.trim();
    if (!trimmed) {
      return;
    }
    session.title = trimmed;
    session.updatedAt = Date.now();
    await this.persistAllSessions();
    this.postSessionState();
  }
  getSamplingConfig() {
    const c = vscode3.workspace.getConfiguration("ollamaCoderChat");
    const temperature = Number(c.get("temperature"));
    const maxTokens = Number(c.get("maxTokens"));
    const topP = Number(c.get("topP"));
    return {
      temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.2,
      maxTokens: Number.isFinite(maxTokens) ? Math.min(128e3, Math.max(1, Math.floor(maxTokens))) : 4096,
      topP: Number.isFinite(topP) ? Math.min(1, Math.max(0.01, topP)) : 1
    };
  }
  async handleWebviewMessage(message) {
    if (message.type === "send") {
      await this.handleSend(message.text, message.mode ?? "agent");
      return;
    }
    if (message.type === "clear" || message.type === "newSession") {
      this.createNewSession();
      return;
    }
    if (message.type === "getModels") {
      await this.refreshModelList();
      return;
    }
    if (message.type === "getSettings") {
      this.postSettingsSnapshot();
      return;
    }
    if (message.type === "saveSettings") {
      await this.saveSettingsFromWebview(message);
      this.postSettingsSnapshot();
      return;
    }
    if (message.type === "setModel") {
      await this.setModel(message.model);
      return;
    }
    if (message.type === "setProvider") {
      const p = message.provider;
      if (p === "ollama" || p === "openrouter" || p === "huggingface") {
        await this.setProvider(p);
      }
      return;
    }
    if (message.type === "switchSession") {
      this.switchSession(message.id);
      return;
    }
    if (message.type === "closeSession") {
      this.closeSession(message.id);
      return;
    }
    if (message.type === "renameSession") {
      await this.renameSessionById(message.id);
      return;
    }
    if (message.type === "removeAttachment") {
      this.attachments = this.attachments.filter((item) => item.id !== message.id);
      this.postAttachments();
      return;
    }
    if (message.type === "attachActiveFile") {
      await this.attachActiveEditorFile();
      return;
    }
    if (message.type === "pickOpenEditor") {
      await this.pickOpenEditorFile();
      return;
    }
    if (message.type === "pickWorkspaceFile") {
      await this.pickWorkspaceFile();
      return;
    }
    if (message.type === "attachProblems") {
      await this.attachActiveProblems();
      return;
    }
    if (message.type === "attachClipboardImage") {
      void vscode3.window.showInformationMessage(
        "Image from clipboard is not supported in this version."
      );
      return;
    }
    if (message.type === "pickLocalFile") {
      await this.handlePickLocalFile();
      return;
    }
    if (message.type === "openBrowser") {
      BrowserPanel.createOrShow(this.context, (msg) => {
        this.postMessagePublic(msg);
      });
      return;
    }
    if (message.type === "applyFileEdit") {
      await this.handleApplyFileEdit(message.code, message.language, message.suggestedPath);
      return;
    }
    if (message.type === "openFile") {
      await this.handleOpenFile(message.path);
      return;
    }
    if (message.type === "runInTerminal") {
      this.handleRunInTerminal(message.command);
      return;
    }
    if (message.type === "getWorkspaceTree") {
      await this.handleGetWorkspaceTree();
      return;
    }
    if (message.type === "gitStatus") {
      await this.handleGitStatus();
      return;
    }
    if (message.type === "gitDiff") {
      await this.handleGitDiff(message.filePath);
      return;
    }
    if (message.type === "gitCommit") {
      await this.handleGitCommit(message.message);
      return;
    }
    if (message.type === "gitPush") {
      await this.handleGitPush();
      return;
    }
    if (message.type === "stub") {
      void vscode3.window.showInformationMessage(
        `${this.titleCase(message.feature)} is not available yet.`
      );
    }
  }
  titleCase(value) {
    if (!value) {
      return "This feature";
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  getProvider() {
    const config = vscode3.workspace.getConfiguration("ollamaCoderChat");
    const raw = config.get("provider");
    if (raw === "openrouter" || raw === "huggingface") {
      return raw;
    }
    return "ollama";
  }
  async setProvider(provider) {
    await vscode3.workspace.getConfiguration("ollamaCoderChat").update("provider", provider, vscode3.ConfigurationTarget.Global);
    this.postMessage({ type: "providerChanged", provider });
    await this.refreshModelList();
  }
  async handleSend(text, mode) {
    const prompt = text.trim();
    if (!prompt || !this.webviewView) {
      return;
    }
    this.abortController?.abort();
    const generation = this.requestGeneration += 1;
    this.abortController = new AbortController();
    const model = this.getConfig("model", "llama3.2");
    const provider = this.getProvider();
    const userContent = this.composeUserMessage(prompt);
    this.messages.push({
      role: "user",
      content: userContent
    });
    this.flushMessagesToActiveSession();
    this.clearAttachmentsAfterSend();
    this.postMessage({
      type: "status",
      status: "Thinking\u2026"
    });
    this.postMessage({
      type: "assistantStart"
    });
    this.progressProvider?.setSteps([
      { label: "Reading your message", status: "done" },
      { label: `Sending to ${provider} (${model.split("/").pop() ?? model})`, status: "active", detail: mode !== "agent" ? mode + " mode" : void 0 },
      { label: "Streaming response", status: "pending" },
      { label: "Done", status: "pending" }
    ]);
    try {
      const responseText = await this.dispatchChat({
        provider,
        model,
        mode,
        signal: this.abortController.signal,
        onDelta: (t) => {
          if (generation === this.requestGeneration) {
            this.postMessage({ type: "assistantDelta", text: t });
            this.progressProvider?.activateStep(2);
          }
        }
      });
      if (generation !== this.requestGeneration) {
        return;
      }
      this.messages.push({
        role: "assistant",
        content: responseText
      });
      this.flushMessagesToActiveSession();
      this.postSessionState();
      this.postMessage({
        type: "assistantDone",
        text: responseText
      });
      this.postMessage({
        type: "status",
        status: "Idle"
      });
      this.progressProvider?.allDone();
      setTimeout(() => {
        if (generation === this.requestGeneration) {
          this.progressProvider?.clear();
        }
      }, 3e3);
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }
      if (error instanceof Error && error.name === "AbortError") {
        this.postMessage({ type: "assistantAbort" });
        this.postMessage({ type: "status", status: "Idle" });
        this.progressProvider?.setSteps([
          { label: "Stopped by user", status: "error" }
        ]);
        setTimeout(() => {
          this.progressProvider?.clear();
        }, 2e3);
        return;
      }
      const messageText = error instanceof Error ? error.message : "Unknown error while calling the model.";
      this.log.appendLine(`[chat error] ${messageText}`);
      this.postMessage({
        type: "assistantError",
        text: `Error: ${messageText}`
      });
      this.postMessage({
        type: "status",
        status: "Error"
      });
      this.progressProvider?.setSteps([
        { label: "Error", status: "error", detail: messageText.slice(0, 80) }
      ]);
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 4e3);
    } finally {
      if (generation === this.requestGeneration) {
        this.abortController = void 0;
      }
    }
  }
  async dispatchChat(args) {
    const systemPrompt = this.buildSystemPrompt(args.mode, args.provider);
    const payloadMessages = [
      { role: "system", content: systemPrompt },
      ...this.messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
    ];
    const { temperature, maxTokens, topP } = this.getSamplingConfig();
    if (args.provider === "ollama") {
      const baseUrl = this.getConfig("baseUrl", "http://127.0.0.1:11434");
      let last2 = 0;
      return await streamOllamaChat({
        baseUrl,
        model: args.model,
        messages: payloadMessages,
        signal: args.signal,
        temperature,
        maxTokens,
        topP,
        onDelta: (t) => {
          const now = Date.now();
          if (now - last2 > 45 || t.length < 8) {
            last2 = now;
            args.onDelta(t);
          }
        }
      });
    }
    if (args.provider === "openrouter") {
      const key2 = await this.context.secrets.get(SECRET_OPENROUTER);
      if (!key2) {
        throw new Error(
          'OpenRouter API key missing. Open the \u2699 panel in the chat header (or run "OllamaUnofficial: Set OpenRouter API Key").'
        );
      }
      const base2 = this.getConfig("openRouterBaseUrl", "https://openrouter.ai/api/v1").replace(
        /\/$/,
        ""
      );
      const url2 = `${base2}/chat/completions`;
      let last2 = 0;
      try {
        return await streamOpenAiCompatibleChat({
          url: url2,
          apiKey: key2,
          model: args.model,
          messages: payloadMessages,
          signal: args.signal,
          temperature,
          maxTokens,
          topP,
          extraHeaders: {
            "HTTP-Referer": "https://github.com/Spiritbocs/ollamaunofficial",
            "X-Title": "OllamaUnofficial"
          },
          onDelta: (t) => {
            const now = Date.now();
            if (now - last2 > 45 || t.length < 8) {
              last2 = now;
              args.onDelta(t);
            }
          }
        });
      } catch (first) {
        this.log.appendLine(`[openrouter stream fallback] ${String(first)}`);
        return await openAiNonStream({
          url: url2,
          apiKey: key2,
          model: args.model,
          messages: payloadMessages,
          signal: args.signal,
          temperature,
          maxTokens,
          topP,
          extraHeaders: {
            "HTTP-Referer": "https://github.com/Spiritbocs/ollamaunofficial",
            "X-Title": "OllamaUnofficial"
          }
        });
      }
    }
    const key = await this.context.secrets.get(SECRET_HUGGINGFACE);
    if (!key) {
      throw new Error(
        'Hugging Face API token missing. Open the \u2699 panel in the chat header (or run "OllamaUnofficial: Set Hugging Face API Token").'
      );
    }
    const base = this.getConfig("huggingfaceApiUrl", "https://router.huggingface.co/v1").replace(
      /\/$/,
      ""
    );
    const url = `${base}/chat/completions`;
    let last = 0;
    try {
      return await streamOpenAiCompatibleChat({
        url,
        apiKey: key,
        model: args.model,
        messages: payloadMessages,
        signal: args.signal,
        temperature,
        maxTokens,
        topP,
        onDelta: (t) => {
          const now = Date.now();
          if (now - last > 45 || t.length < 8) {
            last = now;
            args.onDelta(t);
          }
        }
      });
    } catch (first) {
      this.log.appendLine(`[huggingface stream fallback] ${String(first)}`);
      return await openAiNonStream({
        url,
        apiKey: key,
        model: args.model,
        messages: payloadMessages,
        signal: args.signal,
        temperature,
        maxTokens,
        topP
      });
    }
  }
  composeUserMessage(prompt) {
    const block = this.formatAttachmentsBlock();
    if (!block) {
      return prompt;
    }
    return `${block}
---

${prompt}`;
  }
  clearAttachmentsAfterSend() {
    this.attachments = [];
    this.postAttachments();
  }
  formatAttachmentsBlock() {
    if (!this.attachments.length) {
      return "";
    }
    const parts = this.attachments.map(
      (item) => `### ${item.label}
\`\`\`
${item.content}
\`\`\``
    );
    return `The user attached the following context for this message:

${parts.join("\n\n")}`;
  }
  buildSystemPrompt(mode, provider) {
    const workspaceContext = this.getWorkspaceContext();
    const fileAccess = this.getFileAccess();
    const terminalAccess = this.getTerminalAccess();
    const gitAccess = this.getGitAccess();
    const approvalMode = this.getApprovalMode();
    const modeLine = mode === "plan" ? "You are in Plan mode: begin with a short numbered plan, then give the most useful details and code." : mode === "ask" ? "You are in Ask mode: answer directly with minimal preamble unless the user asks for depth." : "You are in Agent mode: break work into steps, prefer concrete actions and code, and ask brief clarifying questions when blocked.";
    const approvalLine = approvalMode === "chat" ? "Workspace policy (chat-only): do not imply you modified files; provide snippets and instructions for the user to apply." : approvalMode === "auto" ? "Workspace policy (auto): present complete edits clearly so the user can apply them quickly." : "Workspace policy (ask): show full proposed changes; assume the user reviews and applies edits manually.";
    const providerLine = provider === "ollama" ? "Inference provider: local Ollama." : provider === "openrouter" ? "Inference provider: OpenRouter (cloud). Respect the user privacy; do not invent credentials." : "Inference provider: Hugging Face Inference (cloud).";
    const fileAccessLine = fileAccess === "readwrite" ? "File access: READ + WRITE. When proposing code for a specific file, start code block with: // File: path/to/file.ext" : fileAccess === "read" ? "File access: READ ONLY. You can see files the user attaches." : "File access: NONE. Work from what the user pastes.";
    const terminalLine = terminalAccess ? "Terminal: ENABLED. Propose shell commands in bash blocks." : "Terminal: DISABLED.";
    const gitLine = gitAccess ? "Git: ENABLED. You may suggest git operations (status, diff, commit, push)." : "Git: DISABLED.";
    return [
      "You are OllamaUnofficial, a coding assistant inside VS Code.",
      providerLine,
      "Be accurate, concise, and practical.",
      modeLine,
      approvalLine,
      fileAccessLine,
      terminalLine,
      gitLine,
      workspaceContext ? "Workspace folders:\n" + workspaceContext : "No workspace folders are open."
    ].join("\n\n");
  }
  getApprovalMode() {
    const config = vscode3.workspace.getConfiguration("ollamaCoderChat");
    const raw = config.get("approvalMode");
    if (raw === "auto" || raw === "chat") {
      return raw;
    }
    return "ask";
  }
  async refreshModelList() {
    const provider = this.getProvider();
    const configuredModel = this.getConfig("model", "llama3.2");
    const configuredExtras = this.getConfiguredModels();
    try {
      if (provider === "ollama") {
        await this.refreshOllamaModels(configuredModel, configuredExtras);
        return;
      }
      if (provider === "openrouter") {
        await this.refreshOpenRouterModels(configuredModel, configuredExtras);
        return;
      }
      await this.refreshHuggingFaceModels(configuredModel, configuredExtras);
    } catch (error) {
      this.log.appendLine(`[models] ${String(error)}`);
      const fallback = Array.from(/* @__PURE__ */ new Set([configuredModel, ...configuredExtras]));
      this.postMessage({
        type: "models",
        models: fallback,
        selectedModel: configuredModel
      });
    }
  }
  async refreshOllamaModels(configuredModel, configuredExtras) {
    const baseUrl = this.getConfig("baseUrl", "http://127.0.0.1:11434");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Ollama tags HTTP ${response.status}`);
    }
    const data = await response.json();
    const installedModels = (data.models ?? []).map((item) => item.name ?? item.model ?? "").filter((value) => value.trim().length > 0);
    const mergedModels = Array.from(
      /* @__PURE__ */ new Set([configuredModel, ...configuredExtras, ...installedModels])
    );
    this.postModels(mergedModels, configuredModel);
  }
  async refreshOpenRouterModels(configuredModel, configuredExtras) {
    const key = await this.context.secrets.get(SECRET_OPENROUTER);
    const base = this.getConfig("openRouterBaseUrl", "https://openrouter.ai/api/v1").replace(
      /\/$/,
      ""
    );
    const freeOnly = vscode3.workspace.getConfiguration("ollamaCoderChat").get("openRouterFreeOnly") ?? true;
    if (!key) {
      const merged = Array.from(/* @__PURE__ */ new Set([configuredModel, ...configuredExtras]));
      this.postModels(merged, configuredModel);
      this.postMessage({ type: "status", status: "Idle" });
      return;
    }
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!response.ok) {
      throw new Error(`OpenRouter models HTTP ${response.status}`);
    }
    const body = await response.json();
    const ids = body.data?.filter((m) => {
      if (!freeOnly) {
        return true;
      }
      const p = m.pricing?.prompt ?? "1";
      const c = m.pricing?.completion ?? "1";
      return p === "0" && c === "0";
    }).map((m) => m.id) ?? [];
    const mergedModels = Array.from(/* @__PURE__ */ new Set([configuredModel, ...configuredExtras, ...ids]));
    this.postModels(mergedModels, configuredModel);
  }
  async refreshHuggingFaceModels(configuredModel, configuredExtras) {
    const key = await this.context.secrets.get(SECRET_HUGGINGFACE);
    const base = this.getConfig("huggingfaceApiUrl", "https://router.huggingface.co/v1").replace(
      /\/$/,
      ""
    );
    let remote = [];
    if (key) {
      try {
        const response = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` }
        });
        if (response.ok) {
          const body = await response.json();
          remote = (body.data ?? []).map((m) => m.id).filter(Boolean);
        }
      } catch {
      }
    }
    const mergedModels = Array.from(
      /* @__PURE__ */ new Set([configuredModel, ...configuredExtras, ...HF_SUGGESTED_MODELS, ...remote])
    );
    this.postModels(mergedModels, configuredModel);
  }
  postModels(models, selectedModel) {
    const withSelected = models.includes(selectedModel) ? models : [selectedModel, ...models];
    this.postMessage({
      type: "models",
      models: withSelected,
      selectedModel
    });
    this.postMessage({
      type: "status",
      status: "Idle"
    });
  }
  async setModel(model) {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }
    await vscode3.workspace.getConfiguration("ollamaCoderChat").update("model", trimmed, vscode3.ConfigurationTarget.Global);
    this.postMessage({
      type: "modelChanged",
      model: trimmed
    });
    await this.refreshModelList();
  }
  getConfiguredModels() {
    const config = vscode3.workspace.getConfiguration("ollamaCoderChat");
    const raw = config.get("models");
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  getWorkspaceContext() {
    const folders = vscode3.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return "";
    }
    return folders.map((folder, index) => `${index + 1}. ${folder.name}  -  ${folder.uri.fsPath}`).join("\n");
  }
  getConfig(key, fallback) {
    const config = vscode3.workspace.getConfiguration("ollamaCoderChat");
    return config.get(key) ?? fallback;
  }
  postMessage(message) {
    this.webviewView?.webview.postMessage(message);
  }
  postMessagePublic(msg) {
    this.postMessage(msg);
  }
  postAttachments() {
    this.postMessage({
      type: "attachmentsUpdated",
      items: this.attachments.map(({ id, label }) => ({ id, label }))
    });
  }
  addAttachment(label, content) {
    const used = this.attachments.reduce((sum, item) => sum + item.content.length, 0);
    const remaining = _OllamaCoderChatViewProvider.maxTotalAttach - used;
    if (remaining <= 0) {
      void vscode3.window.showWarningMessage("Attachment budget full; remove a chip or start a new chat.");
      return;
    }
    const cap = Math.min(_OllamaCoderChatViewProvider.maxAttachChars, remaining);
    const body = content.length > cap ? `${content.slice(0, cap)}

[\u2026truncated\u2026]` : content;
    const id = `a${this.nextAttachmentId++}`;
    this.attachments.push({
      id,
      label,
      content: body
    });
    this.postAttachments();
  }
  async readUriText(uri) {
    const bytes = await vscode3.workspace.fs.readFile(uri);
    return new TextDecoder("utf-8").decode(bytes);
  }
  async attachActiveEditorFile() {
    const editor = vscode3.window.activeTextEditor;
    if (!editor) {
      void vscode3.window.showWarningMessage("No active editor to attach.");
      return;
    }
    const label = vscode3.workspace.asRelativePath(editor.document.uri, false);
    const content = editor.document.getText();
    this.addAttachment(label, content);
  }
  async pickOpenEditorFile() {
    const items = [];
    for (const group of vscode3.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode3.TabInputText) {
          items.push({
            label: tab.label,
            description: tab.input.uri.fsPath,
            uri: tab.input.uri
          });
        }
      }
    }
    if (!items.length) {
      void vscode3.window.showInformationMessage("No open editor tabs found.");
      return;
    }
    const picked = await vscode3.window.showQuickPick(items, {
      placeHolder: "Choose a tab to attach"
    });
    if (!picked) {
      return;
    }
    const text = await this.readUriText(picked.uri);
    const label = vscode3.workspace.asRelativePath(picked.uri, false);
    this.addAttachment(label, text);
  }
  async pickWorkspaceFile() {
    const picked = await vscode3.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Attach"
    });
    if (!picked?.[0]) {
      return;
    }
    const uri = picked[0];
    const text = await this.readUriText(uri);
    const label = vscode3.workspace.asRelativePath(uri, false);
    this.addAttachment(label || uri.fsPath, text);
  }
  async handlePickLocalFile() {
    const picked = await vscode3.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Attach to Chat",
      filters: {
        "All supported": ["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "cs", "rb", "php", "swift", "kt", "md", "txt", "json", "yaml", "yml", "toml", "xml", "html", "css", "scss", "sql", "sh", "bash", "ps1", "png", "jpg", "jpeg", "gif", "webp", "svg"],
        "Images": ["png", "jpg", "jpeg", "gif", "webp", "svg"],
        "All files": ["*"]
      }
    });
    if (!picked?.[0]) return;
    const uri = picked[0];
    const ext = uri.fsPath.split(".").pop()?.toLowerCase() ?? "";
    const imageExts = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
    const label = uri.fsPath.split(/[/\\]/).pop() ?? uri.fsPath;
    if (imageExts.has(ext)) {
      const bytes = await vscode3.workspace.fs.readFile(uri);
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      const b64 = Buffer.from(bytes).toString("base64");
      this.addAttachment(`[img] ${label}`, `[Image: ${label}]
data:${mime};base64,${b64.substring(0, 200)}\u2026 (${bytes.byteLength} bytes)`);
    } else {
      const text = await this.readUriText(uri);
      this.addAttachment(label, text);
    }
  }
  async attachActiveProblems() {
    const editor = vscode3.window.activeTextEditor;
    if (!editor) {
      void vscode3.window.showWarningMessage("No active editor for problems.");
      return;
    }
    const diags = vscode3.languages.getDiagnostics(editor.document.uri);
    if (!diags.length) {
      void vscode3.window.showInformationMessage("No diagnostics for the active file.");
      return;
    }
    const lines = diags.map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = d.severity === vscode3.DiagnosticSeverity.Error ? "error" : d.severity === vscode3.DiagnosticSeverity.Warning ? "warning" : "info";
      return `${sev} ${line}:${col}  -  ${d.message}`;
    });
    const label = `${vscode3.workspace.asRelativePath(editor.document.uri, false)} (problems)`;
    this.addAttachment(label, lines.join("\n"));
  }
  // ─── Ollama health-check ────────────────────────────────────────────────────
  async checkOllamaStatus() {
    if (this.getProvider() !== "ollama") return;
    const baseUrl = this.getConfig("baseUrl", "http://127.0.0.1:11434");
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/version`, {
        signal: AbortSignal.timeout(4e3)
      });
      if (res.ok) {
        const data = await res.json();
        const ver = data.version ?? "";
        this.log.appendLine(`[ollama] running v${ver}`);
        this.postMessage({ type: "ollamaState", state: "running", version: ver });
        void this.checkOllamaForUpdates(ver);
        return;
      }
    } catch {
    }
    const installed = await this.isOllamaInstalled();
    if (installed) {
      this.postMessage({ type: "ollamaState", state: "not-running" });
      const choice = await vscode3.window.showWarningMessage(
        "OllamaUnofficial: Ollama is installed but not running.",
        "Start Ollama",
        "Dismiss"
      );
      if (choice === "Start Ollama") this.startOllamaProcess();
    } else {
      this.postMessage({ type: "ollamaState", state: "not-installed" });
      const choice = await vscode3.window.showWarningMessage(
        "OllamaUnofficial: Ollama is not installed. It is required for local AI models.",
        "Download Ollama",
        "Use Cloud Instead",
        "Dismiss"
      );
      if (choice === "Download Ollama") {
        void vscode3.env.openExternal(vscode3.Uri.parse("https://ollama.com/download"));
      } else if (choice === "Use Cloud Instead") {
        await this.setProvider("openrouter");
      }
    }
  }
  async isOllamaInstalled() {
    return new Promise((resolve) => {
      const cmd = process.platform === "win32" ? "where" : "which";
      (0, import_child_process.execFile)(cmd, ["ollama"], (err) => {
        if (!err) {
          resolve(true);
          return;
        }
        const paths = process.platform === "win32" ? [`${process.env.LOCALAPPDATA ?? ""}\\Programs\\Ollama\\ollama.exe`] : process.platform === "darwin" ? ["/Applications/Ollama.app/Contents/MacOS/ollama", "/usr/local/bin/ollama"] : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
        const checks = paths.map(
          (p) => new Promise((res) => fs2.access(p, fs2.constants.F_OK, (e) => res(!e)))
        );
        void Promise.all(checks).then((results) => resolve(results.some(Boolean)));
      });
    });
  }
  startOllamaProcess() {
    if (process.platform === "darwin") {
      (0, import_child_process.execFile)("open", ["-a", "Ollama"]);
    } else if (process.platform === "win32") {
      const exe = `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Ollama\\ollama app.exe`;
      (0, import_child_process.execFile)(exe, [], (err) => {
        if (err) (0, import_child_process.execFile)("ollama", ["serve"]);
      });
    } else {
      const term = vscode3.window.createTerminal({ name: "Ollama Server" });
      term.sendText("ollama serve");
      term.show();
    }
    setTimeout(() => {
      void this.checkOllamaStatus();
    }, 5e3);
  }
  async checkOllamaForUpdates(currentVersion) {
    try {
      const res = await fetch("https://api.github.com/repos/ollama/ollama/releases/latest", {
        headers: { "User-Agent": "OllamaUnofficial-VSCode" },
        signal: AbortSignal.timeout(6e3)
      });
      if (!res.ok) return;
      const data = await res.json();
      const latest = (data.tag_name ?? "").replace(/^v/, "");
      const current = currentVersion.replace(/^v/, "");
      if (latest && current && latest !== current) {
        const choice = await vscode3.window.showInformationMessage(
          `OllamaUnofficial: Ollama update available (v${current} \u2192 v${latest}).`,
          "Download Update",
          "Dismiss"
        );
        if (choice === "Download Update") {
          void vscode3.env.openExternal(vscode3.Uri.parse("https://ollama.com/download"));
        }
      }
    } catch {
    }
  }
  // ─── Permissions ────────────────────────────────────────────────────────────
  getFileAccess() {
    const raw = vscode3.workspace.getConfiguration("ollamaCoderChat").get("fileAccess");
    return raw === "read" || raw === "readwrite" ? raw : "none";
  }
  getTerminalAccess() {
    return vscode3.workspace.getConfiguration("ollamaCoderChat").get("terminalAccess") ?? false;
  }
  getGitAccess() {
    return vscode3.workspace.getConfiguration("ollamaCoderChat").get("gitAccess") ?? false;
  }
  // File operations
  async handleOpenFile(filePath) {
    if (this.getFileAccess() === "none") {
      void vscode3.window.showWarningMessage("OllamaUnofficial: Enable file access in the settings first.");
      return;
    }
    const ws = vscode3.workspace.workspaceFolders?.[0];
    const uri = nodePath2.isAbsolute(filePath) ? vscode3.Uri.file(filePath) : ws ? vscode3.Uri.joinPath(ws.uri, filePath) : void 0;
    if (!uri) {
      void vscode3.window.showWarningMessage(`Cannot resolve: ${filePath}`);
      return;
    }
    try {
      const doc = await vscode3.workspace.openTextDocument(uri);
      await vscode3.window.showTextDocument(doc, { preview: false });
    } catch {
      void vscode3.window.showWarningMessage(`OllamaUnofficial: File not found: ${filePath}`);
    }
  }
  async handleApplyFileEdit(code, _language, suggestedPath) {
    if (this.getFileAccess() !== "readwrite") {
      void vscode3.window.showWarningMessage(
        'OllamaUnofficial: Enable "Read & Write" file access in the \u2699 settings panel first.'
      );
      return;
    }
    let targetUri;
    if (suggestedPath) {
      const ws = vscode3.workspace.workspaceFolders?.[0];
      if (ws) targetUri = vscode3.Uri.joinPath(ws.uri, suggestedPath);
    }
    if (!targetUri) {
      const picked = await vscode3.window.showSaveDialog({
        defaultUri: vscode3.workspace.workspaceFolders?.[0]?.uri,
        saveLabel: "Apply to this file"
      });
      if (!picked) return;
      targetUri = picked;
    }
    try {
      await vscode3.workspace.fs.readFile(targetUri);
      const rel2 = vscode3.workspace.asRelativePath(targetUri);
      const choice = await vscode3.window.showInformationMessage(
        `Apply AI-proposed changes to ${rel2}? This will overwrite its current contents.`,
        "Apply",
        "Cancel"
      );
      if (choice !== "Apply") return;
    } catch {
    }
    const rel = vscode3.workspace.asRelativePath(targetUri);
    this.progressProvider?.setSteps([
      { label: "Writing file", status: "active", detail: rel }
    ]);
    await vscode3.workspace.fs.writeFile(targetUri, new TextEncoder().encode(code));
    const doc = await vscode3.workspace.openTextDocument(targetUri);
    await vscode3.window.showTextDocument(doc, { preview: false });
    void vscode3.window.showInformationMessage(
      `OllamaUnofficial: Applied \u2192 ${rel}`
    );
    this.progressProvider?.allDone();
    setTimeout(() => {
      this.progressProvider?.clear();
    }, 2500);
  }
  async handleGetWorkspaceTree() {
    const folders = vscode3.workspace.workspaceFolders;
    if (!folders?.length) {
      this.postMessage({ type: "workspaceTree", tree: "No workspace folder open." });
      return;
    }
    const lines = [];
    for (const folder of folders) {
      lines.push(`Folder: ${folder.name}/`);
      try {
        await this.appendDirTree(folder.uri, "", lines, 0, 3);
      } catch {
      }
    }
    this.postMessage({ type: "workspaceTree", tree: lines.join("\n") });
  }
  async appendDirTree(uri, prefix, lines, depth, maxDepth) {
    if (depth >= maxDepth) return;
    const IGNORE = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".vscode", "coverage", ".cache"]);
    let entries;
    try {
      entries = await vscode3.workspace.fs.readDirectory(uri);
    } catch {
      return;
    }
    entries.sort(([an, at], [bn, bt]) => {
      const ad = at === vscode3.FileType.Directory ? 0 : 1;
      const bd = bt === vscode3.FileType.Directory ? 0 : 1;
      return ad !== bd ? ad - bd : an.localeCompare(bn);
    });
    const visible = entries.filter(([n]) => !IGNORE.has(n) && !n.startsWith("."));
    for (let i = 0; i < visible.length; i++) {
      const [name, type] = visible[i];
      const isLast = i === visible.length - 1;
      const branch = isLast ? "L-- " : "+-- ";
      const childPfx = isLast ? "    " : "|   ";
      if (type === vscode3.FileType.Directory) {
        lines.push(`${prefix}${branch}${name}/`);
        await this.appendDirTree(vscode3.Uri.joinPath(uri, name), prefix + childPfx, lines, depth + 1, maxDepth);
      } else {
        lines.push(`${prefix}${branch}${name}`);
      }
    }
  }
  // Terminal operations
  handleRunInTerminal(command) {
    if (!this.getTerminalAccess()) {
      void vscode3.window.showWarningMessage("OllamaUnofficial: Enable terminal access in the settings first.");
      return;
    }
    if (!this.ollamaTerminal || this.ollamaTerminal.exitStatus !== void 0) {
      this.ollamaTerminal = vscode3.window.createTerminal({ name: "OllamaUnofficial" });
    }
    this.progressProvider?.setSteps([
      { label: "Running in terminal", status: "active", detail: command.slice(0, 60) }
    ]);
    this.ollamaTerminal.show();
    this.ollamaTerminal.sendText(command);
    setTimeout(() => {
      this.progressProvider?.clear();
    }, 2e3);
  }
  // Git operations
  async handleGitStatus() {
    if (!this.getGitAccess()) {
      void vscode3.window.showWarningMessage("OllamaUnofficial: Enable git access in the settings first.");
      return;
    }
    this.progressProvider?.setSteps([{ label: "Getting git status", status: "active" }]);
    try {
      const gitExt = vscode3.extensions.getExtension("vscode.git");
      if (!gitExt) {
        this.postMessage({ type: "gitResult", op: "status", output: "Git extension not available." });
        return;
      }
      if (!gitExt.isActive) await gitExt.activate();
      const api = gitExt.exports.getAPI(1);
      const repo = api.repositories[0];
      if (!repo) {
        this.postMessage({ type: "gitResult", op: "status", output: "No git repository found." });
        return;
      }
      const changes = repo.state.workingTreeChanges;
      if (!changes.length) {
        this.postMessage({ type: "gitResult", op: "status", output: "Working tree clean." });
        return;
      }
      const statusMap = { 0: " M", 1: " A", 2: " D", 5: "MM", 6: "??" };
      const lines = changes.map((c) => `${statusMap[c.status] ?? " M"}  ${vscode3.workspace.asRelativePath(c.uri)}`);
      this.postMessage({ type: "gitResult", op: "status", output: `Changes:
${lines.join("\n")}` });
      this.progressProvider?.allDone();
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 2e3);
    } catch (err) {
      this.progressProvider?.errorStep(0, String(err instanceof Error ? err.message : err).slice(0, 60));
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 3e3);
      this.postMessage({ type: "gitResult", op: "status", output: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  async handleGitDiff(filePath) {
    if (!this.getGitAccess()) {
      void vscode3.window.showWarningMessage("OllamaUnofficial: Enable git access in the settings first.");
      return;
    }
    if (filePath) {
      const ws = vscode3.workspace.workspaceFolders?.[0];
      if (ws) {
        const uri = vscode3.Uri.joinPath(ws.uri, filePath);
        await vscode3.commands.executeCommand("git.openChange", uri);
      }
    } else {
      await vscode3.commands.executeCommand("workbench.view.scm");
    }
  }
  async handleGitCommit(commitMessage) {
    if (!this.getGitAccess()) {
      void vscode3.window.showWarningMessage("OllamaUnofficial: Enable git access in the settings first.");
      return;
    }
    const choice = await vscode3.window.showInformationMessage(
      `Commit with message: '${commitMessage}'?`,
      "Commit",
      "Cancel"
    );
    if (choice !== "Commit") return;
    this.progressProvider?.setSteps([
      { label: "Staging changes", status: "done" },
      { label: "Committing", status: "active", detail: commitMessage.slice(0, 60) }
    ]);
    try {
      const gitExt = vscode3.extensions.getExtension("vscode.git");
      if (!gitExt) return;
      if (!gitExt.isActive) await gitExt.activate();
      const api = gitExt.exports.getAPI(1);
      const repo = api.repositories[0];
      if (!repo) {
        void vscode3.window.showWarningMessage("No git repository found.");
        return;
      }
      await repo.commit(commitMessage, { all: false });
      void vscode3.window.showInformationMessage(`Committed: '${commitMessage}'`);
      this.postMessage({ type: "gitResult", op: "commit", output: `Committed: '${commitMessage}'` });
      this.progressProvider?.allDone();
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 2500);
    } catch (err) {
      this.progressProvider?.errorStep(1, String(err instanceof Error ? err.message : err).slice(0, 60));
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 3e3);
      void vscode3.window.showErrorMessage(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async handleGitPush() {
    if (!this.getGitAccess()) {
      void vscode3.window.showWarningMessage("OllamaUnofficial: Enable git access in the settings first.");
      return;
    }
    const choice = await vscode3.window.showWarningMessage("Push current branch to remote?", { modal: true }, "Push", "Cancel");
    if (choice !== "Push") return;
    this.progressProvider?.setSteps([
      { label: "Connecting to remote", status: "active" },
      { label: "Pushing branch", status: "pending" }
    ]);
    try {
      this.progressProvider?.activateStep(1);
      await vscode3.commands.executeCommand("git.push");
      this.postMessage({ type: "gitResult", op: "push", output: "Pushed to remote successfully." });
      this.progressProvider?.allDone();
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 2500);
    } catch (err) {
      this.progressProvider?.errorStep(1, String(err instanceof Error ? err.message : err).slice(0, 60));
      setTimeout(() => {
        this.progressProvider?.clear();
      }, 3e3);
      void vscode3.window.showErrorMessage(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode3.Uri.joinPath(this.context.extensionUri, "dist", "chat.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode3.Uri.joinPath(this.context.extensionUri, "media", "chat.css")
    );
    const iconUri = webview.asWebviewUri(
      vscode3.Uri.joinPath(this.context.extensionUri, "media", "icon.svg")
    );
    const model = this.getConfig("model", "llama3.2");
    const provider = this.getProvider();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='UTF-8' />
  <meta http-equiv='Content-Security-Policy' content='${csp}' />
  <meta name='viewport' content='width=device-width, initial-scale=1.0' />
  <title>OllamaUnofficial</title>
  <link rel='stylesheet' href='${styleUri}' />
</head>
<body>
  <div class='claude-app'>
    <header class='claude-header'>
      <div class='header-left'>
        <span class='logo-mark' aria-hidden='true'></span>
        <span class='header-title'>OllamaUnofficial</span>
      </div>
      <div class='header-right'>
        <select id='providerSelect' class='provider-pill' title='Inference provider'>
          <option value='ollama'${provider === "ollama" ? " selected" : ""}>Ollama (local)</option>
          <option value='openrouter'${provider === "openrouter" ? " selected" : ""}>OpenRouter</option>
          <option value='huggingface'${provider === "huggingface" ? " selected" : ""}>Hugging Face</option>
        </select>
        <select id='modelSelect' class='model-pill' title='Model'>
          <option value='${escapeHtml(model)}'>${escapeHtml(model)}</option>
        </select>
        <button type='button' class='icon-only' id='refreshModelsBtn' title='Refresh models'>\u21BB</button>
        <button type='button' class='icon-only' id='settingsBtn' title='Chat settings (keys, temperature\u2026)'>\u2699</button>
        <button type='button' class='icon-only' id='newChatBtn' title='New chat tab'>+</button>
      </div>
    </header>

    <div class='session-bar' id='sessionBar'></div>

    <div class='thread-meta'>
      <div class='status-pill' id='statusPill'>
        <span class='status-dot'></span>
        <span id='statusText'>Idle</span>
      </div>
      <span class='hint-mini'>Keys: Enter send \xB7 Shift+Enter newline</span>
    </div>

    <div id='mainView' class='main-view'>
    <main class='claude-main'>
      <div class='empty' id='emptyState'>
        <div class='empty-inner'>
          <img class='empty-logo' src='${iconUri}' alt='' />
          <h1 class='empty-title'>OllamaUnofficial</h1>
          <p class='empty-sub'>Free AI coding assistant \u2014 use <strong>Ollama</strong> locally or <strong>OpenRouter</strong> / <strong>Hugging Face</strong> in the cloud.</p>
          <table class='cap-table'>
            <tr><td>File Read/Write</td><td><span class='cap-val' id='capFile'>Off</span></td></tr>
            <tr><td>Inline Editing</td><td><span class='cap-val' id='capEdit'>Off</span></td></tr>
            <tr><td>Terminal Access</td><td><span class='cap-val' id='capTerm'>Off</span></td></tr>
            <tr><td>Git Integration</td><td><span class='cap-val' id='capGit'>Off</span></td></tr>
            <tr><td>File Navigation</td><td><span class='cap-val' id='capNav'>Off</span></td></tr>
            <tr><td>Multi-file Context</td><td><span class='cap-val cap-on'>On</span></td></tr>
            <tr><td>Code Generation</td><td><span class='cap-val cap-on'>On</span></td></tr>
            <tr><td>Chat Context</td><td><span class='cap-val cap-on'>On</span></td></tr>
          </table>
          <p class='empty-hint'>Click <strong>\u2699</strong> to configure API keys &amp; permissions.</p>
        </div>
      </div>
      <div class='messages' id='messages' data-drop-zone='true'></div>
    </main>

    <footer class='claude-composer-wrap'>
      <div class='attachment-row hidden' id='attachmentRow'></div>
      <div class='composer-card'>
        <textarea id='prompt' placeholder='Message\u2026' rows='3'></textarea>
        <div class='composer-bar'>
          <div class='tools-left'>
            <button type='button' class='tool-btn' id='attachBtn' title='Add context'>+ Context</button>
            <button type='button' class='tool-btn' id='browseBtn' title='Browse web and select content'>\u{1F310}</button>
            <div class='mode-seg' title='Conversation style'>
              <button type='button' id='modeAgent'>Agent</button>
              <button type='button' id='modeAsk'>Ask</button>
              <button type='button' id='modePlan'>Plan</button>
            </div>
            <div class='menu' id='attachMenu'>
              <div class='menu-search'>
                <input id='attachSearch' type='text' placeholder='Filter\u2026' />
              </div>
              <div class='menu-list'>
                <button type='button' class='menu-item' data-action='activeFile' data-filter='active file editor tab'>
                  Active file
                </button>
                <button type='button' class='menu-item' data-action='openEditors' data-filter='open editors tabs'>
                  Open editors\u2026
                </button>
                <button type='button' class='menu-item' data-action='workspaceFile' data-filter='files folders workspace disk'>
                  File from disk\u2026
                </button>
                <button type='button' class='menu-item' data-action='localFile' data-filter='upload file local computer drag drop'>
                  Upload file\u2026
                </button>
                <button type='button' class='menu-item' data-action='problems' data-filter='problems diagnostics errors warnings'>
                  Problems (active file)
                </button>
                <button type='button' class='menu-item' data-action='clipboardImage' data-filter='image clipboard picture'>
                  Image from clipboard
                </button>
                <div class='menu-divider'></div>
                <div class='menu-section'>More</div>
                <button type='button' class='menu-item' data-action='instructions' data-filter='instructions rules'>
                  Instructions\u2026
                </button>
                <button type='button' class='menu-item' data-action='symbols' data-filter='symbols outline'>
                  Symbols\u2026
                </button>
              </div>
            </div>
          </div>
          <div class='tools-right'>
            <button type='button' class='tool-btn primary-send' id='sendBtn' title='Send'>\u2191</button>
          </div>
        </div>
      </div>
      <div class='composer-footer-hint'>
        <span>\u2699 Header for keys &amp; sampling</span>
        <span class='hint-muted'>Palette commands still work</span>
      </div>
    </footer>
    </div><!-- /#mainView -->

    <!-- Settings panel replaces main content \u2014 no absolute positioning needed -->
    <div id='settingsOverlay' class='settings-overlay hidden' aria-hidden='true'>
      <div class='settings-panel' id='settingsPanelInner' role='dialog' aria-labelledby='settingsTitle'>
        <div class='settings-header'>
          <span id='settingsTitle' class='settings-title'>Chat settings</span>
          <button type='button' class='icon-only settings-close' id='settingsCloseBtn' title='Close'>\xD7</button>
        </div>
        <div class='settings-body'>
          <label class='settings-label'>OpenRouter API key <span class='settings-hint' id='orKeyHint'></span></label>
          <input type='password' class='settings-input' id='inputOpenRouterKey' autocomplete='off' placeholder='sk-or-\u2026' />

          <label class='settings-label'>Hugging Face token <span class='settings-hint' id='hfKeyHint'></span></label>
          <input type='password' class='settings-input' id='inputHfKey' autocomplete='off' placeholder='hf_\u2026' />

          <div class='settings-row'>
            <div class='settings-field'>
              <label class='settings-label' for='inputTemperature'>Temperature</label>
              <input type='number' class='settings-input' id='inputTemperature' min='0' max='2' step='0.05' />
            </div>
            <div class='settings-field'>
              <label class='settings-label' for='inputMaxTokens'>Max tokens</label>
              <input type='number' class='settings-input' id='inputMaxTokens' min='1' max='128000' step='1' />
            </div>
            <div class='settings-field'>
              <label class='settings-label' for='inputTopP'>Top P</label>
              <input type='number' class='settings-input' id='inputTopP' min='0.01' max='1' step='0.01' />
            </div>
          </div>

          <label class='settings-check'>
            <input type='checkbox' id='chkOpenRouterFreeOnly' />
            <span>OpenRouter model list: free ($0) only</span>
          </label>

          <div style='border-top:1px solid rgba(255,255,255,0.1);margin:16px 0;padding-top:16px;'>
            <h3 style='margin:0 0 12px 0;font-size:13px;font-weight:600;opacity:0.9;'>Workspace & Terminal</h3>
            <label class='settings-check'>
              <input type='checkbox' id='chkTerminalAccess' />
              <span>Allow terminal command execution</span>
            </label>
            <label class='settings-check'>
              <input type='checkbox' id='chkGitAccess' />
              <span>Allow git operations (status, diff, commit, push)</span>
            </label>
          </div>

          <p class='settings-footnote'>Secrets are stored in VS Code Secret Storage, not settings.json.</p>
        </div>
        <div class='settings-actions'>
          <button type='button' class='tool-btn' id='settingsCancelBtn'>Cancel</button>
          <button type='button' class='settings-save-btn' id='settingsSaveBtn'>Save</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce='${nonce}' src='${scriptUri}'></script>
</body>
</html>`;
  }
};
async function promptForSecret(context, secretKey, title, placeholder) {
  const value = await vscode3.window.showInputBox({
    title,
    prompt: "Stored securely in VS Code Secret Storage (not in settings.json).",
    password: true,
    placeHolder: placeholder,
    ignoreFocusOut: true
  });
  if (!value?.trim()) {
    return;
  }
  await context.secrets.store(secretKey, value.trim());
  void vscode3.window.showInformationMessage(`${title}: saved.`);
}
function activate(context) {
  const provider = new OllamaCoderChatViewProvider(context);
  const progressProvider = new ProgressViewProvider();
  provider.setProgressProvider(progressProvider);
  context.subscriptions.push(
    vscode3.window.registerWebviewViewProvider(OllamaCoderChatViewProvider.viewType, provider)
  );
  context.subscriptions.push(
    vscode3.window.registerWebviewViewProvider(ProgressViewProvider.viewType, progressProvider)
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("ollamaCoderChat.focus", async () => {
      await vscode3.commands.executeCommand("ollamaCoderChat.sidebar.focus");
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("ollamaCoderChat.newChat", () => {
      provider.createNewSession();
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand(
      "ollamaCoderChat.setOpenRouterApiKey",
      () => promptForSecret(
        context,
        SECRET_OPENROUTER,
        "OpenRouter API key",
        "sk-or-\u2026 from https://openrouter.ai/keys"
      )
    )
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand(
      "ollamaCoderChat.setHuggingFaceApiToken",
      () => promptForSecret(
        context,
        SECRET_HUGGINGFACE,
        "Hugging Face token",
        "hf_\u2026 (Inference Providers permission)"
      )
    )
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("ollamaCoderChat.showLog", () => {
      provider.showLog();
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("ollamaCoderChat.openBrowser", () => {
      BrowserPanel.createOrShow(context, (msg) => {
        provider.postMessagePublic(msg);
      });
    })
  );
  checkForUpdates(context, provider.getLog());
}
function deactivate() {
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
