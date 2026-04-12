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
var vscode = __toESM(require("vscode"));

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
    this.log = vscode.window.createOutputChannel("OllamaUnofficial");
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
      void vscode.window.showInformationMessage("Keep at least one chat tab.");
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
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        try {
          await this.handleWebviewMessage(message);
        } catch (error) {
          const text = error instanceof Error ? error.message : "Unexpected error in extension host.";
          this.log.appendLine(`[error] ${text}`);
          void vscode.window.showErrorMessage(`OllamaUnofficial: ${text}`);
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
    const c = vscode.workspace.getConfiguration("ollamaCoderChat");
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
      openRouterFreeOnly: c.get("openRouterFreeOnly") ?? true
    });
  }
  async saveSettingsFromWebview(message) {
    if (message.openRouterKey?.trim()) {
      await this.context.secrets.store(SECRET_OPENROUTER, message.openRouterKey.trim());
    }
    if (message.huggingfaceKey?.trim()) {
      await this.context.secrets.store(SECRET_HUGGINGFACE, message.huggingfaceKey.trim());
    }
    const config = vscode.workspace.getConfiguration("ollamaCoderChat");
    if (typeof message.temperature === "number" && Number.isFinite(message.temperature)) {
      await config.update(
        "temperature",
        Math.min(2, Math.max(0, message.temperature)),
        vscode.ConfigurationTarget.Global
      );
    }
    if (typeof message.maxTokens === "number" && Number.isFinite(message.maxTokens)) {
      await config.update(
        "maxTokens",
        Math.min(128e3, Math.max(1, Math.floor(message.maxTokens))),
        vscode.ConfigurationTarget.Global
      );
    }
    if (typeof message.topP === "number" && Number.isFinite(message.topP)) {
      await config.update(
        "topP",
        Math.min(1, Math.max(0.01, message.topP)),
        vscode.ConfigurationTarget.Global
      );
    }
    if (typeof message.openRouterFreeOnly === "boolean") {
      await config.update(
        "openRouterFreeOnly",
        message.openRouterFreeOnly,
        vscode.ConfigurationTarget.Global
      );
    }
    await this.refreshModelList();
    void vscode.window.showInformationMessage("OllamaUnofficial: settings saved.");
  }
  async renameSessionById(id) {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    const next = await vscode.window.showInputBox({
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
    const c = vscode.workspace.getConfiguration("ollamaCoderChat");
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
      void vscode.window.showInformationMessage(
        "Image from clipboard is not supported in this version."
      );
      return;
    }
    if (message.type === "stub") {
      void vscode.window.showInformationMessage(
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
    const config = vscode.workspace.getConfiguration("ollamaCoderChat");
    const raw = config.get("provider");
    if (raw === "openrouter" || raw === "huggingface") {
      return raw;
    }
    return "ollama";
  }
  async setProvider(provider) {
    await vscode.workspace.getConfiguration("ollamaCoderChat").update("provider", provider, vscode.ConfigurationTarget.Global);
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
    try {
      const responseText = await this.dispatchChat({
        provider,
        model,
        mode,
        signal: this.abortController.signal,
        onDelta: (t) => {
          if (generation === this.requestGeneration) {
            this.postMessage({ type: "assistantDelta", text: t });
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
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }
      if (error instanceof Error && error.name === "AbortError") {
        this.postMessage({ type: "assistantAbort" });
        this.postMessage({ type: "status", status: "Idle" });
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
          "OpenRouter API key missing. Open the \u2699 panel in the chat header (or run \u201COllamaUnofficial: Set OpenRouter API Key\u201D)."
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
        "Hugging Face API token missing. Open the \u2699 panel in the chat header (or run \u201COllamaUnofficial: Set Hugging Face API Token\u201D)."
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
    const approvalMode = this.getApprovalMode();
    const modeLine = mode === "plan" ? "You are in Plan mode: begin with a short numbered plan, then give the most useful details and code." : mode === "ask" ? "You are in Ask mode: answer directly with minimal preamble unless the user asks for depth." : "You are in Agent mode: break work into steps, prefer concrete actions and code, and ask brief clarifying questions when blocked.";
    const approvalLine = approvalMode === "chat" ? "Workspace policy (chat-only): do not imply you modified files; provide snippets and instructions for the user to apply." : approvalMode === "auto" ? "Workspace policy (auto): present complete edits clearly so the user can apply them quickly." : "Workspace policy (ask): show full proposed changes; assume the user reviews and applies edits manually.";
    const providerLine = provider === "ollama" ? "Inference provider: local Ollama." : provider === "openrouter" ? "Inference provider: OpenRouter (cloud). Respect the user\u2019s privacy; do not invent credentials." : "Inference provider: Hugging Face Inference (cloud).";
    return [
      "You are OllamaUnofficial, a coding assistant inside VS Code.",
      providerLine,
      "Be accurate, concise, and practical.",
      modeLine,
      approvalLine,
      workspaceContext ? `Workspace folders:
${workspaceContext}` : "No workspace folders are open."
    ].join("\n\n");
  }
  getApprovalMode() {
    const config = vscode.workspace.getConfiguration("ollamaCoderChat");
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
    const freeOnly = vscode.workspace.getConfiguration("ollamaCoderChat").get("openRouterFreeOnly") ?? true;
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
    await vscode.workspace.getConfiguration("ollamaCoderChat").update("model", trimmed, vscode.ConfigurationTarget.Global);
    this.postMessage({
      type: "modelChanged",
      model: trimmed
    });
    await this.refreshModelList();
  }
  getConfiguredModels() {
    const config = vscode.workspace.getConfiguration("ollamaCoderChat");
    const raw = config.get("models");
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  getWorkspaceContext() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return "";
    }
    return folders.map((folder, index) => `${index + 1}. ${folder.name} \u2014 ${folder.uri.fsPath}`).join("\n");
  }
  getConfig(key, fallback) {
    const config = vscode.workspace.getConfiguration("ollamaCoderChat");
    return config.get(key) ?? fallback;
  }
  postMessage(message) {
    this.webviewView?.webview.postMessage(message);
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
      void vscode.window.showWarningMessage("Attachment budget full; remove a chip or start a new chat.");
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
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder("utf-8").decode(bytes);
  }
  async attachActiveEditorFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("No active editor to attach.");
      return;
    }
    const label = vscode.workspace.asRelativePath(editor.document.uri, false);
    const content = editor.document.getText();
    this.addAttachment(label, content);
  }
  async pickOpenEditorFile() {
    const items = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          items.push({
            label: tab.label,
            description: tab.input.uri.fsPath,
            uri: tab.input.uri
          });
        }
      }
    }
    if (!items.length) {
      void vscode.window.showInformationMessage("No open editor tabs found.");
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose a tab to attach"
    });
    if (!picked) {
      return;
    }
    const text = await this.readUriText(picked.uri);
    const label = vscode.workspace.asRelativePath(picked.uri, false);
    this.addAttachment(label, text);
  }
  async pickWorkspaceFile() {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Attach"
    });
    if (!picked?.[0]) {
      return;
    }
    const uri = picked[0];
    const text = await this.readUriText(uri);
    const label = vscode.workspace.asRelativePath(uri, false);
    this.addAttachment(label || uri.fsPath, text);
  }
  async attachActiveProblems() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("No active editor for problems.");
      return;
    }
    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    if (!diags.length) {
      void vscode.window.showInformationMessage("No diagnostics for the active file.");
      return;
    }
    const lines = diags.map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : d.severity === vscode.DiagnosticSeverity.Warning ? "warning" : "info";
      return `${sev} ${line}:${col} \u2014 ${d.message}`;
    });
    const label = `${vscode.workspace.asRelativePath(editor.document.uri, false)} (problems)`;
    this.addAttachment(label, lines.join("\n"));
  }
  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "chat.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.css")
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg")
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
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OllamaUnofficial</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="claude-app">
    <header class="claude-header">
      <div class="header-left">
        <span class="logo-mark" aria-hidden="true"></span>
        <span class="header-title">OllamaUnofficial</span>
      </div>
      <div class="header-right">
        <select id="providerSelect" class="provider-pill" title="Inference provider">
          <option value="ollama"${provider === "ollama" ? " selected" : ""}>Ollama (local)</option>
          <option value="openrouter"${provider === "openrouter" ? " selected" : ""}>OpenRouter</option>
          <option value="huggingface"${provider === "huggingface" ? " selected" : ""}>Hugging Face</option>
        </select>
        <select id="modelSelect" class="model-pill" title="Model">
          <option value="${escapeHtml(model)}">${escapeHtml(model)}</option>
        </select>
        <button type="button" class="icon-only" id="refreshModelsBtn" title="Refresh models">\u21BB</button>
        <button type="button" class="icon-only" id="settingsBtn" title="Chat settings (keys, temperature\u2026)">\u2699</button>
        <button type="button" class="icon-only" id="newChatBtn" title="New chat tab">+</button>
      </div>
    </header>

    <div class="session-bar" id="sessionBar"></div>

    <div class="thread-meta">
      <div class="status-pill" id="statusPill">
        <span class="status-dot"></span>
        <span id="statusText">Idle</span>
      </div>
      <span class="hint-mini">Keys: Enter send \xB7 Shift+Enter newline</span>
    </div>

    <main class="claude-main">
      <div class="empty" id="emptyState">
        <div class="empty-inner">
          <img class="empty-logo" src="${iconUri}" alt="" />
          <h1>Free & local models</h1>
          <p>
            Use <strong>Ollama</strong> locally or <strong>OpenRouter</strong> / <strong>Hugging Face</strong> in the cloud. Click <strong>\u2699</strong> in the header for API keys, temperature, and token limits. Pin extra model ids in VS Code settings under <code>ollamaCoderChat.models</code>. Use <strong>+</strong> for a new tab; <strong>\u270E</strong> on a tab to rename it.
          </p>
          <p><span class="kbd">Enter</span> send \xB7 <span class="kbd">Shift</span>+<span class="kbd">Enter</span> line</p>
        </div>
      </div>
      <div class="messages" id="messages"></div>
    </main>

    <footer class="claude-composer-wrap">
      <div class="attachment-row hidden" id="attachmentRow"></div>
      <div class="composer-card">
        <textarea id="prompt" placeholder="Message\u2026" rows="3"></textarea>
        <div class="composer-bar">
          <div class="tools-left">
            <button type="button" class="tool-btn" id="attachBtn" title="Add context">+ Context</button>
            <div class="mode-seg" title="Conversation style">
              <button type="button" id="modeAgent">Agent</button>
              <button type="button" id="modeAsk">Ask</button>
              <button type="button" id="modePlan">Plan</button>
            </div>
            <div class="menu" id="attachMenu">
              <div class="menu-search">
                <input id="attachSearch" type="text" placeholder="Filter\u2026" />
              </div>
              <div class="menu-list">
                <button type="button" class="menu-item" data-action="activeFile" data-filter="active file editor tab">
                  Active file
                </button>
                <button type="button" class="menu-item" data-action="openEditors" data-filter="open editors tabs">
                  Open editors\u2026
                </button>
                <button type="button" class="menu-item" data-action="workspaceFile" data-filter="files folders workspace disk">
                  File from disk\u2026
                </button>
                <button type="button" class="menu-item" data-action="problems" data-filter="problems diagnostics errors warnings">
                  Problems (active file)
                </button>
                <button type="button" class="menu-item" data-action="clipboardImage" data-filter="image clipboard picture">
                  Image from clipboard
                </button>
                <div class="menu-divider"></div>
                <div class="menu-section">More</div>
                <button type="button" class="menu-item" data-action="instructions" data-filter="instructions rules">
                  Instructions\u2026
                </button>
                <button type="button" class="menu-item" data-action="symbols" data-filter="symbols outline">
                  Symbols\u2026
                </button>
              </div>
            </div>
          </div>
          <div class="tools-right">
            <button type="button" class="tool-btn primary-send" id="sendBtn" title="Send">\u2191</button>
          </div>
        </div>
      </div>
      <div class="composer-footer-hint">
        <span>\u2699 Header for keys &amp; sampling</span>
        <span class="hint-muted">Palette commands still work</span>
      </div>
    </footer>

    <div id="settingsOverlay" class="settings-overlay hidden" aria-hidden="true">
      <div class="settings-panel" id="settingsPanelInner" role="dialog" aria-labelledby="settingsTitle">
        <div class="settings-header">
          <span id="settingsTitle" class="settings-title">Chat settings</span>
          <button type="button" class="icon-only settings-close" id="settingsCloseBtn" title="Close">\xD7</button>
        </div>
        <div class="settings-body">
          <label class="settings-label">OpenRouter API key <span class="settings-hint" id="orKeyHint"></span></label>
          <input type="password" class="settings-input" id="inputOpenRouterKey" autocomplete="off" placeholder="sk-or-\u2026" />

          <label class="settings-label">Hugging Face token <span class="settings-hint" id="hfKeyHint"></span></label>
          <input type="password" class="settings-input" id="inputHfKey" autocomplete="off" placeholder="hf_\u2026" />

          <div class="settings-row">
            <div class="settings-field">
              <label class="settings-label" for="inputTemperature">Temperature</label>
              <input type="number" class="settings-input" id="inputTemperature" min="0" max="2" step="0.05" />
            </div>
            <div class="settings-field">
              <label class="settings-label" for="inputMaxTokens">Max tokens</label>
              <input type="number" class="settings-input" id="inputMaxTokens" min="1" max="128000" step="1" />
            </div>
            <div class="settings-field">
              <label class="settings-label" for="inputTopP">Top P</label>
              <input type="number" class="settings-input" id="inputTopP" min="0.01" max="1" step="0.01" />
            </div>
          </div>

          <label class="settings-check">
            <input type="checkbox" id="chkOpenRouterFreeOnly" />
            <span>OpenRouter model list: free ($0) only</span>
          </label>

          <p class="settings-footnote">Secrets are stored in VS Code Secret Storage, not settings.json.</p>
        </div>
        <div class="settings-actions">
          <button type="button" class="tool-btn" id="settingsCancelBtn">Cancel</button>
          <button type="button" class="settings-save-btn" id="settingsSaveBtn">Save</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
};
async function promptForSecret(context, secretKey, title, placeholder) {
  const value = await vscode.window.showInputBox({
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
  void vscode.window.showInformationMessage(`${title}: saved.`);
}
function activate(context) {
  const provider = new OllamaCoderChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OllamaCoderChatViewProvider.viewType, provider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaCoderChat.focus", async () => {
      await vscode.commands.executeCommand("ollamaCoderChat.sidebar.focus");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaCoderChat.newChat", () => {
      provider.createNewSession();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand("ollamaCoderChat.showLog", () => {
      provider.showLog();
    })
  );
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
