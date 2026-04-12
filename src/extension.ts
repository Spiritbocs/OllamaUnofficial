import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';
import {
  loadSessions,
  randomId,
  saveSessions,
  upsertSessionTitleFromMessages,
  type ChatSession,
  type PersistedMessage,
} from './chatSessions';
import { streamOllamaChat } from './llm/ollamaStream';
import { openAiNonStream, streamOpenAiCompatibleChat } from './llm/openaiSseStream';
import { SECRET_HUGGINGFACE, SECRET_OPENROUTER } from './secrets';
import { BrowserPanel } from './browserPanel';

type ChatMessage = PersistedMessage;

type ChatMode = 'agent' | 'ask' | 'plan';

type ProviderId = 'ollama' | 'openrouter' | 'huggingface';

type FileAccessLevel = 'none' | 'read' | 'readwrite';

type Attachment = {
  id: string;
  label: string;
  content: string;
};

type WebviewInboundMessage =
  | { type: 'send'; text: string; mode?: ChatMode }
  | { type: 'clear' }
  | { type: 'newSession' }
  | { type: 'getModels' }
  | { type: 'getSettings' }
  | {
      type: 'saveSettings';
      openRouterKey?: string;
      huggingfaceKey?: string;
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      openRouterFreeOnly?: boolean;
      fileAccess?: string;
      fileScope?: string;
      terminalAccess?: boolean;
      gitAccess?: boolean;
    }
  | { type: 'setModel'; model: string }
  | { type: 'setProvider'; provider: ProviderId }
  | { type: 'switchSession'; id: string }
  | { type: 'closeSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'removeAttachment'; id: string }
  | { type: 'attachActiveFile' }
  | { type: 'pickOpenEditor' }
  | { type: 'pickWorkspaceFile' }
  | { type: 'attachProblems' }
  | { type: 'attachClipboardImage' }
  | { type: 'pickLocalFile' }
  | { type: 'openBrowser' }
  | { type: 'stub'; feature: string }
  | { type: 'applyFileEdit'; code: string; language: string; suggestedPath?: string }
  | { type: 'openFile'; path: string }
  | { type: 'runInTerminal'; command: string }
  | { type: 'getWorkspaceTree' }
  | { type: 'gitStatus' }
  | { type: 'gitDiff'; filePath?: string }
  | { type: 'gitCommit'; message: string }
  | { type: 'gitPush' };

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

const HF_SUGGESTED_MODELS = [
  'Qwen/Qwen2.5-Coder-7B-Instruct',
  'Qwen/Qwen2.5-7B-Instruct',
  'meta-llama/Llama-3.2-3B-Instruct',
  'HuggingFaceTB/SmolLM2-1.7B-Instruct',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
];

class OllamaCoderChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollamaCoderChat.sidebar';

  private static readonly maxAttachChars = 28_000;
  private static readonly maxTotalAttach = 96_000;

  private webviewView?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private abortController?: AbortController;
  private requestGeneration = 0;
  private attachments: Attachment[] = [];
  private nextAttachmentId = 1;
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private readonly log: vscode.OutputChannel;
  private ollamaTerminal?: vscode.Terminal;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('OllamaUnofficial');
    context.subscriptions.push(this.log);
    const loaded = loadSessions(this.context.globalState);
    this.sessions = loaded.sessions;
    this.activeSessionId = loaded.activeSessionId;
    this.messages = this.getActiveSession()?.messages.map((m) => ({ ...m })) ?? [];
  }

  private getActiveSession(): ChatSession | undefined {
    return this.sessions.find((s) => s.id === this.activeSessionId);
  }

  private flushMessagesToActiveSession(): void {
    const session = this.getActiveSession();

    if (!session) {
      return;
    }

    session.messages = this.messages.map((m) => ({ ...m }));
    session.updatedAt = Date.now();
    upsertSessionTitleFromMessages(session);
    void saveSessions(this.context.globalState, this.sessions, this.activeSessionId);
  }

  public showLog(): void {
    this.log.show(true);
  }

  private async persistAllSessions(): Promise<void> {
    await saveSessions(this.context.globalState, this.sessions, this.activeSessionId);
  }

  public createNewSession(): void {
    this.requestGeneration += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.flushMessagesToActiveSession();

    const id = randomId();
    this.sessions.push({ id, title: 'New chat', updatedAt: Date.now(), messages: [] });
    this.activeSessionId = id;
    this.messages = [];
    this.attachments = [];
    this.postAttachments();
    void this.persistAllSessions();
    this.postMessage({ type: 'cleared' });
    this.postSessionState();
    this.postMessage({ type: 'status', status: 'Idle' });
  }

  /** Legacy: treat as new session (tab) */
  public clearChat(): void {
    this.createNewSession();
  }

  private switchSession(id: string): void {
    if (id === this.activeSessionId) {
      return;
    }

    const next = this.sessions.find((s) => s.id === id);

    if (!next) {
      return;
    }

    this.requestGeneration += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.flushMessagesToActiveSession();
    this.activeSessionId = id;
    this.messages = next.messages.map((m) => ({ ...m }));
    this.attachments = [];
    this.postAttachments();
    void this.persistAllSessions();
    this.postThreadSnapshot();
    this.postSessionState();
    this.postMessage({ type: 'status', status: 'Idle' });
  }

  private closeSession(id: string): void {
    if (this.sessions.length <= 1) {
      void vscode.window.showInformationMessage('Keep at least one chat tab.');
      return;
    }

    const idx = this.sessions.findIndex((s) => s.id === id);

    if (idx < 0) {
      return;
    }

    this.requestGeneration += 1;
    this.abortController?.abort();
    this.abortController = undefined;

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

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewInboundMessage) => {
        try {
          await this.handleWebviewMessage(message);
        } catch (error) {
          const text =
            error instanceof Error ? error.message : 'Unexpected error in extension host.';
          this.log.appendLine(`[error] ${text}`);
          void vscode.window.showErrorMessage(`OllamaUnofficial: ${text}`);
        }
      },
      undefined,
      this.context.subscriptions
    );

    webviewView.webview.html = this.getHtml(webviewView.webview);
    void this.refreshModelList();
    this.postAttachments();
    this.postSessionState();
    this.postThreadSnapshot();
  }

  private postSessionState(): void {
    this.postMessage({
      type: 'sessionState',
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
      provider: this.getProvider(),
    });
  }

  private postThreadSnapshot(): void {
    this.postMessage({
      type: 'loadThread',
      messages: this.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
  }

  private async postSettingsSnapshot(): Promise<void> {
    const c = vscode.workspace.getConfiguration('ollamaCoderChat');
    const [openRouterKey, huggingfaceKey] = await Promise.all([
      this.context.secrets.get(SECRET_OPENROUTER),
      this.context.secrets.get(SECRET_HUGGINGFACE),
    ]);

    this.postMessage({
      type: 'settingsForm',
      hasOpenRouterKey: Boolean(openRouterKey?.length),
      hasHuggingfaceKey: Boolean(huggingfaceKey?.length),
      temperature: c.get<number>('temperature') ?? 0.2,
      maxTokens: c.get<number>('maxTokens') ?? 4096,
      topP: c.get<number>('topP') ?? 1,
      openRouterFreeOnly: c.get<boolean>('openRouterFreeOnly') ?? true,
      fileAccess: c.get<string>('fileAccess') ?? 'none',
      fileScope: c.get<string>('fileScope') ?? 'workspace',
      terminalAccess: c.get<boolean>('terminalAccess') ?? false,
      gitAccess: c.get<boolean>('gitAccess') ?? false,
    });
  }

  private async saveSettingsFromWebview(
    message: Extract<WebviewInboundMessage, { type: 'saveSettings' }>
  ): Promise<void> {
    if (message.openRouterKey?.trim()) {
      await this.context.secrets.store(SECRET_OPENROUTER, message.openRouterKey.trim());
    }

    if (message.huggingfaceKey?.trim()) {
      await this.context.secrets.store(SECRET_HUGGINGFACE, message.huggingfaceKey.trim());
    }

    const config = vscode.workspace.getConfiguration('ollamaCoderChat');

    if (typeof message.temperature === 'number' && Number.isFinite(message.temperature)) {
      await config.update(
        'temperature',
        Math.min(2, Math.max(0, message.temperature)),
        vscode.ConfigurationTarget.Global
      );
    }

    if (typeof message.maxTokens === 'number' && Number.isFinite(message.maxTokens)) {
      await config.update(
        'maxTokens',
        Math.min(128_000, Math.max(1, Math.floor(message.maxTokens))),
        vscode.ConfigurationTarget.Global
      );
    }

    if (typeof message.topP === 'number' && Number.isFinite(message.topP)) {
      await config.update(
        'topP',
        Math.min(1, Math.max(0.01, message.topP)),
        vscode.ConfigurationTarget.Global
      );
    }

    if (typeof message.openRouterFreeOnly === 'boolean') {
      await config.update(
        'openRouterFreeOnly',
        message.openRouterFreeOnly,
        vscode.ConfigurationTarget.Global
      );
    }

    if (typeof message.terminalAccess === 'boolean') {
      await config.update('terminalAccess', message.terminalAccess, vscode.ConfigurationTarget.Global);
    }

    if (typeof message.gitAccess === 'boolean') {
      await config.update('gitAccess', message.gitAccess, vscode.ConfigurationTarget.Global);
    }

    await this.refreshModelList();
    void vscode.window.showInformationMessage('OllamaUnofficial: settings saved.');
  }

  private async renameSessionById(id: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === id);

    if (!session) {
      return;
    }

    const next = await vscode.window.showInputBox({
      title: 'Rename chat tab',
      value: session.title,
      validateInput: (value) => (value.trim().length > 0 ? undefined : 'Enter a name'),
    });

    if (next === undefined) {
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

  private getSamplingConfig(): { temperature: number; maxTokens: number; topP: number } {
    const c = vscode.workspace.getConfiguration('ollamaCoderChat');
    const temperature = Number(c.get('temperature'));
    const maxTokens = Number(c.get('maxTokens'));
    const topP = Number(c.get('topP'));

    return {
      temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.2,
      maxTokens: Number.isFinite(maxTokens)
        ? Math.min(128_000, Math.max(1, Math.floor(maxTokens)))
        : 4096,
      topP: Number.isFinite(topP) ? Math.min(1, Math.max(0.01, topP)) : 1,
    };
  }

  private async handleWebviewMessage(message: WebviewInboundMessage): Promise<void> {
    if (message.type === 'send') {
      await this.handleSend(message.text, message.mode ?? 'agent');
      return;
    }

    if (message.type === 'clear' || message.type === 'newSession') {
      this.createNewSession();
      return;
    }

    if (message.type === 'getModels') {
      await this.refreshModelList();
      return;
    }

    if (message.type === 'getSettings') {
      this.postSettingsSnapshot();
      return;
    }

    if (message.type === 'saveSettings') {
      await this.saveSettingsFromWebview(message);
      this.postSettingsSnapshot();
      return;
    }

    if (message.type === 'setModel') {
      await this.setModel(message.model);
      return;
    }

    if (message.type === 'setProvider') {
      const p = message.provider;
      if (p === 'ollama' || p === 'openrouter' || p === 'huggingface') {
        await this.setProvider(p);
      }
      return;
    }

    if (message.type === 'switchSession') {
      this.switchSession(message.id);
      return;
    }

    if (message.type === 'closeSession') {
      this.closeSession(message.id);
      return;
    }

    if (message.type === 'renameSession') {
      await this.renameSessionById(message.id);
      return;
    }

    if (message.type === 'removeAttachment') {
      this.attachments = this.attachments.filter((item) => item.id !== message.id);
      this.postAttachments();
      return;
    }

    if (message.type === 'attachActiveFile') {
      await this.attachActiveEditorFile();
      return;
    }

    if (message.type === 'pickOpenEditor') {
      await this.pickOpenEditorFile();
      return;
    }

    if (message.type === 'pickWorkspaceFile') {
      await this.pickWorkspaceFile();
      return;
    }

    if (message.type === 'attachProblems') {
      await this.attachActiveProblems();
      return;
    }

    if (message.type === 'attachClipboardImage') {
      void vscode.window.showInformationMessage(
        'Image from clipboard is not supported in this version.'
      );
      return;
    }

    if (message.type === 'pickLocalFile') {
      await this.handlePickLocalFile();
      return;
    }

    if (message.type === 'openBrowser') {
      BrowserPanel.createOrShow(this.context, (msg) => {
        this.postMessagePublic(msg as Record<string, unknown>);
      });
      return;
    }

    if (message.type === 'applyFileEdit') {
      await this.handleApplyFileEdit(message.code, message.language, message.suggestedPath);
      return;
    }

    if (message.type === 'openFile') {
      await this.handleOpenFile(message.path);
      return;
    }

    if (message.type === 'runInTerminal') {
      this.handleRunInTerminal(message.command);
      return;
    }

    if (message.type === 'getWorkspaceTree') {
      await this.handleGetWorkspaceTree();
      return;
    }

    if (message.type === 'gitStatus') {
      await this.handleGitStatus();
      return;
    }

    if (message.type === 'gitDiff') {
      await this.handleGitDiff(message.filePath);
      return;
    }

    if (message.type === 'gitCommit') {
      await this.handleGitCommit(message.message);
      return;
    }

    if (message.type === 'gitPush') {
      await this.handleGitPush();
      return;
    }

    if (message.type === 'stub') {
      void vscode.window.showInformationMessage(
        `${this.titleCase(message.feature)} is not available yet.`
      );
    }
  }

  private titleCase(value: string): string {
    if (!value) {
      return 'This feature';
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private getProvider(): ProviderId {
    const config = vscode.workspace.getConfiguration('ollamaCoderChat');
    const raw = config.get<string>('provider');
    if (raw === 'openrouter' || raw === 'huggingface') {
      return raw;
    }
    return 'ollama';
  }

  private async setProvider(provider: ProviderId): Promise<void> {
    await vscode.workspace
      .getConfiguration('ollamaCoderChat')
      .update('provider', provider, vscode.ConfigurationTarget.Global);

    this.postMessage({ type: 'providerChanged', provider });
    await this.refreshModelList();
  }

  private async handleSend(text: string, mode: ChatMode): Promise<void> {
    const prompt = text.trim();

    if (!prompt || !this.webviewView) {
      return;
    }

    this.abortController?.abort();
    const generation = (this.requestGeneration += 1);
    this.abortController = new AbortController();

    const model = this.getConfig('model', 'llama3.2');
    const provider = this.getProvider();

    const userContent = this.composeUserMessage(prompt);

    this.messages.push({
      role: 'user',
      content: userContent,
    });

    this.flushMessagesToActiveSession();
    this.clearAttachmentsAfterSend();

    this.postMessage({
      type: 'status',
      status: 'Thinking…',
    });

    this.postMessage({
      type: 'assistantStart',
    });

    try {
      const responseText = await this.dispatchChat({
        provider,
        model,
        mode,
        signal: this.abortController.signal,
        onDelta: (t) => {
          if (generation === this.requestGeneration) {
            this.postMessage({ type: 'assistantDelta', text: t });
          }
        },
      });

      if (generation !== this.requestGeneration) {
        return;
      }

      this.messages.push({
        role: 'assistant',
        content: responseText,
      });

      this.flushMessagesToActiveSession();
      this.postSessionState();

      this.postMessage({
        type: 'assistantDone',
        text: responseText,
      });

      this.postMessage({
        type: 'status',
        status: 'Idle',
      });
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        this.postMessage({ type: 'assistantAbort' });
        this.postMessage({ type: 'status', status: 'Idle' });
        return;
      }

      const messageText =
        error instanceof Error ? error.message : 'Unknown error while calling the model.';

      this.log.appendLine(`[chat error] ${messageText}`);

      this.postMessage({
        type: 'assistantError',
        text: `Error: ${messageText}`,
      });

      this.postMessage({
        type: 'status',
        status: 'Error',
      });
    } finally {
      if (generation === this.requestGeneration) {
        this.abortController = undefined;
      }
    }
  }

  private async dispatchChat(args: {
    provider: ProviderId;
    model: string;
    mode: ChatMode;
    signal: AbortSignal;
    onDelta: (text: string) => void;
  }): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(args.mode, args.provider);
    const payloadMessages = [
      { role: 'system', content: systemPrompt },
      ...this.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const { temperature, maxTokens, topP } = this.getSamplingConfig();

    if (args.provider === 'ollama') {
      const baseUrl = this.getConfig('baseUrl', 'http://127.0.0.1:11434');
      let last = 0;

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
          if (now - last > 45 || t.length < 8) {
            last = now;
            args.onDelta(t);
          }
        },
      });
    }

    if (args.provider === 'openrouter') {
      const key = await this.context.secrets.get(SECRET_OPENROUTER);

      if (!key) {
        throw new Error(
          'OpenRouter API key missing. Open the ⚙ panel in the chat header (or run "OllamaUnofficial: Set OpenRouter API Key").'
        );
      }

      const base = this.getConfig('openRouterBaseUrl', 'https://openrouter.ai/api/v1').replace(
        /\/$/,
        ''
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
          extraHeaders: {
            'HTTP-Referer': 'https://github.com/Spiritbocs/ollamaunofficial',
            'X-Title': 'OllamaUnofficial',
          },
          onDelta: (t) => {
            const now = Date.now();
            if (now - last > 45 || t.length < 8) {
              last = now;
              args.onDelta(t);
            }
          },
        });
      } catch (first) {
        this.log.appendLine(`[openrouter stream fallback] ${String(first)}`);
        return await openAiNonStream({
          url,
          apiKey: key,
          model: args.model,
          messages: payloadMessages,
          signal: args.signal,
          temperature,
          maxTokens,
          topP,
          extraHeaders: {
            'HTTP-Referer': 'https://github.com/Spiritbocs/ollamaunofficial',
            'X-Title': 'OllamaUnofficial',
          },
        });
      }
    }

    const key = await this.context.secrets.get(SECRET_HUGGINGFACE);

    if (!key) {
      throw new Error(
        'Hugging Face API token missing. Open the ⚙ panel in the chat header (or run "OllamaUnofficial: Set Hugging Face API Token").'
      );
    }

    const base = this.getConfig('huggingfaceApiUrl', 'https://router.huggingface.co/v1').replace(
      /\/$/,
      ''
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
        },
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
        topP,
      });
    }
  }

  private composeUserMessage(prompt: string): string {
    const block = this.formatAttachmentsBlock();
    if (!block) {
      return prompt;
    }
    return `${block}\n---\n\n${prompt}`;
  }

  private clearAttachmentsAfterSend(): void {
    this.attachments = [];
    this.postAttachments();
  }

  private formatAttachmentsBlock(): string {
    if (!this.attachments.length) {
      return '';
    }

    const parts = this.attachments.map(
      (item) => `### ${item.label}\n\`\`\`\n${item.content}\n\`\`\``
    );

    return `The user attached the following context for this message:\n\n${parts.join('\n\n')}`;
  }

  private buildSystemPrompt(mode: ChatMode, provider: ProviderId): string {
    const workspaceContext = this.getWorkspaceContext();
    const fileAccess = this.getFileAccess();
    const terminalAccess = this.getTerminalAccess();
    const gitAccess = this.getGitAccess();
    const approvalMode = this.getApprovalMode();

    const modeLine =
      mode === 'plan'
        ? 'You are in Plan mode: begin with a short numbered plan, then give the most useful details and code.'
        : mode === 'ask'
          ? 'You are in Ask mode: answer directly with minimal preamble unless the user asks for depth.'
          : 'You are in Agent mode: break work into steps, prefer concrete actions and code, and ask brief clarifying questions when blocked.';

    const approvalLine =
      approvalMode === 'chat'
        ? 'Workspace policy (chat-only): do not imply you modified files; provide snippets and instructions for the user to apply.'
        : approvalMode === 'auto'
          ? 'Workspace policy (auto): present complete edits clearly so the user can apply them quickly.'
          : 'Workspace policy (ask): show full proposed changes; assume the user reviews and applies edits manually.';

    const providerLine =
      provider === 'ollama'
        ? 'Inference provider: local Ollama.'
        : provider === 'openrouter'
          ? 'Inference provider: OpenRouter (cloud). Respect the user privacy; do not invent credentials.'
          : 'Inference provider: Hugging Face Inference (cloud).';

    const fileAccessLine =
      fileAccess === 'readwrite'
        ? 'File access: READ + WRITE. When proposing code for a specific file, start code block with: // File: path/to/file.ext'
        : fileAccess === 'read'
          ? 'File access: READ ONLY. You can see files the user attaches.'
          : 'File access: NONE. Work from what the user pastes.';

    const terminalLine = terminalAccess
      ? 'Terminal: ENABLED. Propose shell commands in bash blocks.'
      : 'Terminal: DISABLED.';

    const gitLine = gitAccess
      ? 'Git: ENABLED. You may suggest git operations (status, diff, commit, push).'
      : 'Git: DISABLED.';

    return [
      'You are OllamaUnofficial, a coding assistant inside VS Code.',
      providerLine,
      'Be accurate, concise, and practical.',
      modeLine,
      approvalLine,
      fileAccessLine,
      terminalLine,
      gitLine,
      workspaceContext
        ? 'Workspace folders:\n' + workspaceContext
        : 'No workspace folders are open.',
    ].join('\n\n');
  }

  private getApprovalMode(): 'ask' | 'auto' | 'chat' {
    const config = vscode.workspace.getConfiguration('ollamaCoderChat');
    const raw = config.get<string>('approvalMode');
    if (raw === 'auto' || raw === 'chat') {
      return raw;
    }
    return 'ask';
  }

  private async refreshModelList(): Promise<void> {
    const provider = this.getProvider();
    const configuredModel = this.getConfig('model', 'llama3.2');
    const configuredExtras = this.getConfiguredModels();

    try {
      if (provider === 'ollama') {
        await this.refreshOllamaModels(configuredModel, configuredExtras);
        return;
      }

      if (provider === 'openrouter') {
        await this.refreshOpenRouterModels(configuredModel, configuredExtras);
        return;
      }

      await this.refreshHuggingFaceModels(configuredModel, configuredExtras);
    } catch (error) {
      this.log.appendLine(`[models] ${String(error)}`);
      const fallback = Array.from(new Set([configuredModel, ...configuredExtras]));
      this.postMessage({
        type: 'models',
        models: fallback,
        selectedModel: configuredModel,
      });
    }
  }

  private async refreshOllamaModels(configuredModel: string, configuredExtras: string[]): Promise<void> {
    const baseUrl = this.getConfig('baseUrl', 'http://127.0.0.1:11434');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Ollama tags HTTP ${response.status}`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const installedModels = (data.models ?? [])
      .map((item) => item.name ?? item.model ?? '')
      .filter((value) => value.trim().length > 0);

    const mergedModels = Array.from(
      new Set([configuredModel, ...configuredExtras, ...installedModels])
    );

    this.postModels(mergedModels, configuredModel);
  }

  private async refreshOpenRouterModels(
    configuredModel: string,
    configuredExtras: string[]
  ): Promise<void> {
    const key = await this.context.secrets.get(SECRET_OPENROUTER);
    const base = this.getConfig('openRouterBaseUrl', 'https://openrouter.ai/api/v1').replace(
      /\/$/,
      ''
    );
    const freeOnly = vscode.workspace.getConfiguration('ollamaCoderChat').get<boolean>('openRouterFreeOnly') ?? true;

    if (!key) {
      const merged = Array.from(new Set([configuredModel, ...configuredExtras]));
      this.postModels(merged, configuredModel);
      this.postMessage({ type: 'status', status: 'Idle' });
      return;
    }

    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: Array<{
        id: string;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };

    const ids =
      body.data
        ?.filter((m) => {
          if (!freeOnly) {
            return true;
          }
          const p = m.pricing?.prompt ?? '1';
          const c = m.pricing?.completion ?? '1';
          return p === '0' && c === '0';
        })
        .map((m) => m.id) ?? [];

    const mergedModels = Array.from(new Set([configuredModel, ...configuredExtras, ...ids]));
    this.postModels(mergedModels, configuredModel);
  }

  private async refreshHuggingFaceModels(
    configuredModel: string,
    configuredExtras: string[]
  ): Promise<void> {
    const key = await this.context.secrets.get(SECRET_HUGGINGFACE);
    const base = this.getConfig('huggingfaceApiUrl', 'https://router.huggingface.co/v1').replace(
      /\/$/,
      ''
    );

    let remote: string[] = [];

    if (key) {
      try {
        const response = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });

        if (response.ok) {
          const body = (await response.json()) as { data?: Array<{ id: string }> };
          remote = (body.data ?? []).map((m) => m.id).filter(Boolean);
        }
      } catch {
        /* ignore */
      }
    }

    const mergedModels = Array.from(
      new Set([configuredModel, ...configuredExtras, ...HF_SUGGESTED_MODELS, ...remote])
    );

    this.postModels(mergedModels, configuredModel);
  }

  private postModels(models: string[], selectedModel: string): void {
    const withSelected = models.includes(selectedModel)
      ? models
      : [selectedModel, ...models];

    this.postMessage({
      type: 'models',
      models: withSelected,
      selectedModel,
    });

    this.postMessage({
      type: 'status',
      status: 'Idle',
    });
  }

  private async setModel(model: string): Promise<void> {
    const trimmed = model.trim();

    if (!trimmed) {
      return;
    }

    await vscode.workspace
      .getConfiguration('ollamaCoderChat')
      .update('model', trimmed, vscode.ConfigurationTarget.Global);

    this.postMessage({
      type: 'modelChanged',
      model: trimmed,
    });

    await this.refreshModelList();
  }

  private getConfiguredModels(): string[] {
    const config = vscode.workspace.getConfiguration('ollamaCoderChat');
    const raw = config.get<string[]>('models');

    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }

  private getWorkspaceContext(): string {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (!folders.length) {
      return '';
    }

    return folders
      .map((folder, index) => `${index + 1}. ${folder.name}  -  ${folder.uri.fsPath}`)
      .join('\n');
  }

  private getConfig<T extends string>(key: string, fallback: T): T {
    const config = vscode.workspace.getConfiguration('ollamaCoderChat');
    return (config.get<string>(key) ?? fallback) as T;
  }

  private postMessage(message: Record<string, unknown>): void {
    this.webviewView?.webview.postMessage(message);
  }

  public postMessagePublic(msg: Record<string, unknown>): void {
    this.postMessage(msg);
  }

  private postAttachments(): void {
    this.postMessage({
      type: 'attachmentsUpdated',
      items: this.attachments.map(({ id, label }) => ({ id, label })),
    });
  }

  private addAttachment(label: string, content: string): void {
    const used = this.attachments.reduce((sum, item) => sum + item.content.length, 0);
    const remaining = OllamaCoderChatViewProvider.maxTotalAttach - used;

    if (remaining <= 0) {
      void vscode.window.showWarningMessage('Attachment budget full; remove a chip or start a new chat.');
      return;
    }

    const cap = Math.min(OllamaCoderChatViewProvider.maxAttachChars, remaining);
    const body =
      content.length > cap ? `${content.slice(0, cap)}\n\n[…truncated…]` : content;

    const id = `a${this.nextAttachmentId++}`;
    this.attachments.push({
      id,
      label,
      content: body,
    });
    this.postAttachments();
  }

  private async readUriText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  }

  private async attachActiveEditorFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      void vscode.window.showWarningMessage('No active editor to attach.');
      return;
    }

    const label = vscode.workspace.asRelativePath(editor.document.uri, false);
    const content = editor.document.getText();
    this.addAttachment(label, content);
  }

  private async pickOpenEditorFile(): Promise<void> {
    type PickItem = vscode.QuickPickItem & { uri: vscode.Uri };
    const items: PickItem[] = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          items.push({
            label: tab.label,
            description: tab.input.uri.fsPath,
            uri: tab.input.uri,
          });
        }
      }
    }

    if (!items.length) {
      void vscode.window.showInformationMessage('No open editor tabs found.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Choose a tab to attach',
    });

    if (!picked) {
      return;
    }

    const text = await this.readUriText(picked.uri);
    const label = vscode.workspace.asRelativePath(picked.uri, false);
    this.addAttachment(label, text);
  }

  private async pickWorkspaceFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
    });

    if (!picked?.[0]) {
      return;
    }

    const uri = picked[0];
    const text = await this.readUriText(uri);
    const label = vscode.workspace.asRelativePath(uri, false);
    this.addAttachment(label || uri.fsPath, text);
  }

  private async handlePickLocalFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach to Chat',
      filters: {
        'All supported': ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'swift', 'kt', 'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss', 'sql', 'sh', 'bash', 'ps1', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
        'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
        'All files': ['*'],
      },
    });
    if (!picked?.[0]) return;
    const uri = picked[0];
    const ext = uri.fsPath.split('.').pop()?.toLowerCase() ?? '';
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
    const label = uri.fsPath.split(/[/\\]/).pop() ?? uri.fsPath;
    if (imageExts.has(ext)) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      const b64 = Buffer.from(bytes).toString('base64');
      this.addAttachment(`[img] ${label}`, `[Image: ${label}]\ndata:${mime};base64,${b64.substring(0, 200)}… (${bytes.byteLength} bytes)`);
    } else {
      const text = await this.readUriText(uri);
      this.addAttachment(label, text);
    }
  }

  private async attachActiveProblems(): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      void vscode.window.showWarningMessage('No active editor for problems.');
      return;
    }

    const diags = vscode.languages.getDiagnostics(editor.document.uri);

    if (!diags.length) {
      void vscode.window.showInformationMessage('No diagnostics for the active file.');
      return;
    }

    const lines = diags.map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error
          ? 'error'
          : d.severity === vscode.DiagnosticSeverity.Warning
            ? 'warning'
            : 'info';
      return `${sev} ${line}:${col}  -  ${d.message}`;
    });

    const label = `${vscode.workspace.asRelativePath(editor.document.uri, false)} (problems)`;
    this.addAttachment(label, lines.join('\n'));
  }

  // ─── Ollama health-check ────────────────────────────────────────────────────

  private async checkOllamaStatus(): Promise<void> {
    if (this.getProvider() !== 'ollama') return;
    const baseUrl = this.getConfig('baseUrl', 'http://127.0.0.1:11434');
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/version`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = (await res.json()) as { version?: string };
        const ver = data.version ?? '';
        this.log.appendLine(`[ollama] running v${ver}`);
        this.postMessage({ type: 'ollamaState', state: 'running', version: ver });
        void this.checkOllamaForUpdates(ver);
        return;
      }
    } catch { /* not reachable */ }

    const installed = await this.isOllamaInstalled();
    if (installed) {
      this.postMessage({ type: 'ollamaState', state: 'not-running' });
      const choice = await vscode.window.showWarningMessage(
        'OllamaUnofficial: Ollama is installed but not running.',
        'Start Ollama', 'Dismiss'
      );
      if (choice === 'Start Ollama') this.startOllamaProcess();
    } else {
      this.postMessage({ type: 'ollamaState', state: 'not-installed' });
      const choice = await vscode.window.showWarningMessage(
        'OllamaUnofficial: Ollama is not installed. It is required for local AI models.',
        'Download Ollama', 'Use Cloud Instead', 'Dismiss'
      );
      if (choice === 'Download Ollama') {
        void vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      } else if (choice === 'Use Cloud Instead') {
        await this.setProvider('openrouter');
      }
    }
  }

  private async isOllamaInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['ollama'], (err) => {
        if (!err) { resolve(true); return; }
        const paths = process.platform === 'win32'
          ? [`${process.env.LOCALAPPDATA ?? ''}\\Programs\\Ollama\\ollama.exe`]
          : process.platform === 'darwin'
            ? ['/Applications/Ollama.app/Contents/MacOS/ollama', '/usr/local/bin/ollama']
            : ['/usr/local/bin/ollama', '/usr/bin/ollama'];
        const checks = paths.map(
          (p) => new Promise<boolean>((res) => fs.access(p, fs.constants.F_OK, (e) => res(!e)))
        );
        void Promise.all(checks).then((results) => resolve(results.some(Boolean)));
      });
    });
  }

  private startOllamaProcess(): void {
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Ollama']);
    } else if (process.platform === 'win32') {
      const exe = `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Ollama\\ollama app.exe`;
      execFile(exe, [], (err) => { if (err) execFile('ollama', ['serve']); });
    } else {
      const term = vscode.window.createTerminal({ name: 'Ollama Server' });
      term.sendText('ollama serve');
      term.show();
    }
    setTimeout(() => { void this.checkOllamaStatus(); }, 5000);
  }

  private async checkOllamaForUpdates(currentVersion: string): Promise<void> {
    try {
      const res = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
        headers: { 'User-Agent': 'OllamaUnofficial-VSCode' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { tag_name?: string };
      const latest = (data.tag_name ?? '').replace(/^v/, '');
      const current = currentVersion.replace(/^v/, '');
      if (latest && current && latest !== current) {
        const choice = await vscode.window.showInformationMessage(
          `OllamaUnofficial: Ollama update available (v${current} → v${latest}).`,
          'Download Update', 'Dismiss'
        );
        if (choice === 'Download Update') {
          void vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        }
      }
    } catch { /* silently ignore */ }
  }

  // ─── Permissions ────────────────────────────────────────────────────────────

  private getFileAccess(): FileAccessLevel {
    const raw = vscode.workspace.getConfiguration('ollamaCoderChat').get<string>('fileAccess');
    return raw === 'read' || raw === 'readwrite' ? raw : 'none';
  }

  private getTerminalAccess(): boolean {
    return vscode.workspace.getConfiguration('ollamaCoderChat').get<boolean>('terminalAccess') ?? false;
  }

  private getGitAccess(): boolean {
    return vscode.workspace.getConfiguration('ollamaCoderChat').get<boolean>('gitAccess') ?? false;
  }

  // File operations

  private async handleOpenFile(filePath: string): Promise<void> {
    if (this.getFileAccess() === 'none') {
      void vscode.window.showWarningMessage('OllamaUnofficial: Enable file access in the settings first.');
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    const uri = nodePath.isAbsolute(filePath)
      ? vscode.Uri.file(filePath)
      : ws ? vscode.Uri.joinPath(ws.uri, filePath) : undefined;
    if (!uri) { void vscode.window.showWarningMessage(`Cannot resolve: ${filePath}`); return; }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      void vscode.window.showWarningMessage(`OllamaUnofficial: File not found: ${filePath}`);
    }
  }

  private async handleApplyFileEdit(code: string, _language: string, suggestedPath?: string): Promise<void> {
    if (this.getFileAccess() !== 'readwrite') {
      void vscode.window.showWarningMessage(
        'OllamaUnofficial: Enable "Read & Write" file access in the ⚙ settings panel first.'
      );
      return;
    }

    let targetUri: vscode.Uri | undefined;
    if (suggestedPath) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) targetUri = vscode.Uri.joinPath(ws.uri, suggestedPath);
    }

    if (!targetUri) {
      const picked = await vscode.window.showSaveDialog({
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        saveLabel: 'Apply to this file',
      });
      if (!picked) return;
      targetUri = picked;
    }

    // Confirm before overwriting an existing file
    try {
      await vscode.workspace.fs.readFile(targetUri);
      const rel = vscode.workspace.asRelativePath(targetUri);
      const choice = await vscode.window.showInformationMessage(
        `Apply AI-proposed changes to ${rel}? This will overwrite its current contents.`,
        'Apply', 'Cancel'
      );
      if (choice !== 'Apply') return;
    } catch { /* file does not exist yet — create it */ }

    await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(code));
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(
      `OllamaUnofficial: Applied → ${vscode.workspace.asRelativePath(targetUri)}`
    );
  }

  private async handleGetWorkspaceTree(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      this.postMessage({ type: 'workspaceTree', tree: 'No workspace folder open.' } as any);
      return;
    }
    const lines: string[] = [];
    for (const folder of folders) {
      lines.push(`Folder: ${folder.name}/`);
      try { await this.appendDirTree(folder.uri, '', lines, 0, 3); } catch { /* ignore */ }
    }
    this.postMessage({ type: 'workspaceTree', tree: lines.join('\n') } as any);
  }

  private async appendDirTree(uri: vscode.Uri, prefix: string, lines: string[], depth: number, maxDepth: number): Promise<void> {
    if (depth >= maxDepth) return;
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.vscode', 'coverage', '.cache']);
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(uri); } catch { return; }
    entries.sort(([an, at], [bn, bt]) => {
      const ad = at === vscode.FileType.Directory ? 0 : 1;
      const bd = bt === vscode.FileType.Directory ? 0 : 1;
      return ad !== bd ? ad - bd : an.localeCompare(bn);
    });
    const visible = entries.filter(([n]) => !IGNORE.has(n) && !n.startsWith('.'));
    for (let i = 0; i < visible.length; i++) {
      const [name, type] = visible[i];
      const isLast = i === visible.length - 1;
      const branch = isLast ? 'L-- ' : '+-- ';
      const childPfx = isLast ? '    ' : '|   ';
      if (type === vscode.FileType.Directory) {
        lines.push(`${prefix}${branch}${name}/`);
        await this.appendDirTree(vscode.Uri.joinPath(uri, name), prefix + childPfx, lines, depth + 1, maxDepth);
      } else {
        lines.push(`${prefix}${branch}${name}`);
      }
    }
  }

  // Terminal operations

  private handleRunInTerminal(command: string): void {
    if (!this.getTerminalAccess()) {
      void vscode.window.showWarningMessage('OllamaUnofficial: Enable terminal access in the settings first.');
      return;
    }
    if (!this.ollamaTerminal || this.ollamaTerminal.exitStatus !== undefined) {
      this.ollamaTerminal = vscode.window.createTerminal({ name: 'OllamaUnofficial' });
    }
    this.ollamaTerminal.show();
    this.ollamaTerminal.sendText(command);
  }

  // Git operations

  private async handleGitStatus(): Promise<void> {
    if (!this.getGitAccess()) {
      void vscode.window.showWarningMessage('OllamaUnofficial: Enable git access in the settings first.');
      return;
    }
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) { this.postMessage({ type: 'gitResult', op: 'status', output: 'Git extension not available.' } as any); return; }
      if (!gitExt.isActive) await gitExt.activate();
      const api = (gitExt.exports as any).getAPI(1);
      const repo = api.repositories[0];
      if (!repo) { this.postMessage({ type: 'gitResult', op: 'status', output: 'No git repository found.' } as any); return; }
      const changes = repo.state.workingTreeChanges;
      if (!changes.length) { this.postMessage({ type: 'gitResult', op: 'status', output: 'Working tree clean.' } as any); return; }
      const statusMap: Record<number, string> = { 0: ' M', 1: ' A', 2: ' D', 5: 'MM', 6: '??' };
      const lines = changes.map((c: any) => `${statusMap[c.status] ?? ' M'}  ${vscode.workspace.asRelativePath(c.uri)}`);
      this.postMessage({ type: 'gitResult', op: 'status', output: `Changes:\n${lines.join('\n')}` } as any);
    } catch (err) {
      this.postMessage({ type: 'gitResult', op: 'status', output: `Error: ${err instanceof Error ? err.message : String(err)}` } as any);
    }
  }

  private async handleGitDiff(filePath?: string): Promise<void> {
    if (!this.getGitAccess()) {
      void vscode.window.showWarningMessage('OllamaUnofficial: Enable git access in the settings first.');
      return;
    }
    if (filePath) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        const uri = vscode.Uri.joinPath(ws.uri, filePath);
        await vscode.commands.executeCommand('git.openChange', uri);
      }
    } else {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  private async handleGitCommit(commitMessage: string): Promise<void> {
    if (!this.getGitAccess()) {
      void vscode.window.showWarningMessage('OllamaUnofficial: Enable git access in the settings first.');
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Commit with message: '${commitMessage}'?`,
      'Commit', 'Cancel'
    );
    if (choice !== 'Commit') return;
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) return;
      if (!gitExt.isActive) await gitExt.activate();
      const api = (gitExt.exports as any).getAPI(1);
      const repo = api.repositories[0];
      if (!repo) { void vscode.window.showWarningMessage('No git repository found.'); return; }
      await repo.commit(commitMessage, { all: false });
      void vscode.window.showInformationMessage(`Committed: '${commitMessage}'`);
      this.postMessage({ type: 'gitResult', op: 'commit', output: `Committed: '${commitMessage}'` } as any);
    } catch (err) {
      void vscode.window.showErrorMessage(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleGitPush(): Promise<void> {
    if (!this.getGitAccess()) {
      void vscode.window.showWarningMessage('OllamaUnofficial: Enable git access in the settings first.');
      return;
    }
    const choice = await vscode.window.showWarningMessage('Push current branch to remote?', { modal: true }, 'Push', 'Cancel');
    if (choice !== 'Push') return;
    try {
      await vscode.commands.executeCommand('git.push');
      this.postMessage({ type: 'gitResult', op: 'push', output: 'Pushed to remote successfully.' } as any);
    } catch (err) {
      void vscode.window.showErrorMessage(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css')
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg')
    );
    const model = this.getConfig('model', 'llama3.2');
    const provider = this.getProvider();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join('; ');

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
          <option value='ollama'${provider === 'ollama' ? ' selected' : ''}>Ollama (local)</option>
          <option value='openrouter'${provider === 'openrouter' ? ' selected' : ''}>OpenRouter</option>
          <option value='huggingface'${provider === 'huggingface' ? ' selected' : ''}>Hugging Face</option>
        </select>
        <select id='modelSelect' class='model-pill' title='Model'>
          <option value='${escapeHtml(model)}'>${escapeHtml(model)}</option>
        </select>
        <button type='button' class='icon-only' id='refreshModelsBtn' title='Refresh models'>↻</button>
        <button type='button' class='icon-only' id='settingsBtn' title='Chat settings (keys, temperature…)'>⚙</button>
        <button type='button' class='icon-only' id='newChatBtn' title='New chat tab'>+</button>
      </div>
    </header>

    <div class='session-bar' id='sessionBar'></div>

    <div class='thread-meta'>
      <div class='status-pill' id='statusPill'>
        <span class='status-dot'></span>
        <span id='statusText'>Idle</span>
      </div>
      <span class='hint-mini'>Keys: Enter send · Shift+Enter newline</span>
    </div>

    <main class='claude-main'>
      <div class='empty' id='emptyState'>
        <div class='empty-inner'>
          <img class='empty-logo' src='${iconUri}' alt='' />
          <h1>OllamaUnofficial</h1>
          <p>Free & local AI coding assistant. Use <strong>Ollama</strong> locally or <strong>OpenRouter</strong> / <strong>Hugging Face</strong> in the cloud.</p>
          <div class='cap-table' style='margin: 12px 0; font-size: 13px; line-height: 1.6;'>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>File Read/Write</span><span id='capFile' style='color:#888;'>Off</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>Multi-file Context</span><span style='color:#0a0;'>On</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>Inline Editing</span><span id='capEdit' style='color:#888;'>Off</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>Code Generation</span><span style='color:#0a0;'>On</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>Terminal Access</span><span id='capTerm' style='color:#888;'>Off</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>Git Integration</span><span id='capGit' style='color:#888;'>Off</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>Chat Context</span><span style='color:#0a0;'>On</span></div>
            <div style='display:flex;justify-content:space-between;padding:4px 0;'><span>File Navigation</span><span id='capNav' style='color:#888;'>Off</span></div>
          </div>
          <p style='margin-top:8px;font-size:11px;opacity:0.7;'>Click <strong>⚙</strong> to configure API keys & permissions.</p>
        </div>
      </div>
      <div class='messages' id='messages' data-drop-zone='true'></div>
    </main>

    <footer class='claude-composer-wrap'>
      <div class='attachment-row hidden' id='attachmentRow'></div>
      <div class='composer-card'>
        <textarea id='prompt' placeholder='Message…' rows='3'></textarea>
        <div class='composer-bar'>
          <div class='tools-left'>
            <button type='button' class='tool-btn' id='attachBtn' title='Add context'>+ Context</button>
            <button type='button' class='tool-btn' id='browseBtn' title='Browse web and select content'>🌐</button>
            <div class='mode-seg' title='Conversation style'>
              <button type='button' id='modeAgent'>Agent</button>
              <button type='button' id='modeAsk'>Ask</button>
              <button type='button' id='modePlan'>Plan</button>
            </div>
            <div class='menu' id='attachMenu'>
              <div class='menu-search'>
                <input id='attachSearch' type='text' placeholder='Filter…' />
              </div>
              <div class='menu-list'>
                <button type='button' class='menu-item' data-action='activeFile' data-filter='active file editor tab'>
                  Active file
                </button>
                <button type='button' class='menu-item' data-action='openEditors' data-filter='open editors tabs'>
                  Open editors…
                </button>
                <button type='button' class='menu-item' data-action='workspaceFile' data-filter='files folders workspace disk'>
                  File from disk…
                </button>
                <button type='button' class='menu-item' data-action='localFile' data-filter='upload file local computer drag drop'>
                  Upload file…
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
                  Instructions…
                </button>
                <button type='button' class='menu-item' data-action='symbols' data-filter='symbols outline'>
                  Symbols…
                </button>
              </div>
            </div>
          </div>
          <div class='tools-right'>
            <button type='button' class='tool-btn primary-send' id='sendBtn' title='Send'>↑</button>
          </div>
        </div>
      </div>
      <div class='composer-footer-hint'>
        <span>⚙ Header for keys &amp; sampling</span>
        <span class='hint-muted'>Palette commands still work</span>
      </div>
    </footer>

    <div id='settingsOverlay' class='settings-overlay hidden' aria-hidden='true'>
      <div class='settings-panel' id='settingsPanelInner' role='dialog' aria-labelledby='settingsTitle'>
        <div class='settings-header'>
          <span id='settingsTitle' class='settings-title'>Chat settings</span>
          <button type='button' class='icon-only settings-close' id='settingsCloseBtn' title='Close'>×</button>
        </div>
        <div class='settings-body'>
          <label class='settings-label'>OpenRouter API key <span class='settings-hint' id='orKeyHint'></span></label>
          <input type='password' class='settings-input' id='inputOpenRouterKey' autocomplete='off' placeholder='sk-or-…' />

          <label class='settings-label'>Hugging Face token <span class='settings-hint' id='hfKeyHint'></span></label>
          <input type='password' class='settings-input' id='inputHfKey' autocomplete='off' placeholder='hf_…' />

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
}

async function promptForSecret(
  context: vscode.ExtensionContext,
  secretKey: string,
  title: string,
  placeholder: string
): Promise<void> {
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Stored securely in VS Code Secret Storage (not in settings.json).',
    password: true,
    placeHolder: placeholder,
    ignoreFocusOut: true,
  });

  if (!value?.trim()) {
    return;
  }

  await context.secrets.store(secretKey, value.trim());
  void vscode.window.showInformationMessage(`${title}: saved.`);
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new OllamaCoderChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OllamaCoderChatViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCoderChat.focus', async () => {
      await vscode.commands.executeCommand('ollamaCoderChat.sidebar.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCoderChat.newChat', () => {
      provider.createNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCoderChat.setOpenRouterApiKey', () =>
      promptForSecret(
        context,
        SECRET_OPENROUTER,
        'OpenRouter API key',
        'sk-or-… from https://openrouter.ai/keys'
      )
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCoderChat.setHuggingFaceApiToken', () =>
      promptForSecret(
        context,
        SECRET_HUGGINGFACE,
        'Hugging Face token',
        'hf_… (Inference Providers permission)'
      )
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCoderChat.showLog', () => {
      provider.showLog();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaCoderChat.openBrowser', () => {
      BrowserPanel.createOrShow(context, (msg) => {
        provider.postMessagePublic(msg as Record<string, unknown>);
      });
    })
  );
}

export function deactivate(): void {}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return value;
}
