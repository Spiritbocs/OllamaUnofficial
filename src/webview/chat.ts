import DOMPurify from 'dompurify';
import { marked } from 'marked';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

type ChatMode = 'agent' | 'ask' | 'plan';

type AttachmentChip = {
  id: string;
  label: string;
};

type ThreadMessage = {
  role: string;
  content: string;
};

type SessionTab = {
  id: string;
  title: string;
};

const vscode = acquireVsCodeApi();

marked.setOptions({
  gfm: true,
  breaks: false,
});

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;

  if (!el) {
    throw new Error(`Ollama chat webview: missing #${id}`);
  }

  return el;
}

function getElOpt<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

/** Extract <think>...</think> blocks from a raw AI response.
 *  Returns the visible text (thinking stripped) and all captured thinking. */
function stripThinkingBlocks(text: string): { visible: string; thinking: string } {
  let thinking = '';
  // Remove complete <think>...</think> blocks
  let visible = text.replace(/<think>([\s\S]*?)<\/think>/g, (_match, inner: string) => {
    thinking += (thinking ? '\n\n' : '') + inner.trim();
    return '';
  }).trim();
  // If there's an unclosed <think> at the end (still streaming), strip it too
  const openIdx = visible.lastIndexOf('<think>');
  if (openIdx !== -1) {
    const tail = visible.slice(openIdx + 7).trim();
    if (tail) {
      thinking += (thinking ? '\n\n' : '') + tail;
    }
    visible = visible.slice(0, openIdx).trim();
  }
  return { visible, thinking };
}

const SPINNER_HTML = `<div class="thinking-spinner"><div class="thinking-spinner-ring"></div><span>Working on it…</span></div>`;

function enhanceCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-actions')) return;

    const actions = document.createElement('div');
    actions.className = 'code-actions';

    // Copy button (always)
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      void navigator.clipboard.writeText(code?.textContent ?? '');
      copyBtn.textContent = 'Copied!';
      window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
    });
    actions.appendChild(copyBtn);

    // Detect language from class
    const codeEl = pre.querySelector('code');
    const langClass = codeEl?.className ?? '';
    const langMatch = /language-(\w+)/.exec(langClass);
    const language = langMatch?.[1] ?? '';

    // Detect file path from first comment line in code
    const rawCode = codeEl?.textContent ?? '';
    const firstLine = rawCode.split('\n')[0].trim();
    const fileMatch = /(?:\/\/|#|<!--)\s*[Ff]ile:\s*(.+?)(?:\s*-->)?$/.exec(firstLine);
    const suggestedPath = fileMatch?.[1]?.trim();

    // Apply to File button (for non-shell, non-output code blocks)
    const isShell = /^(bash|sh|shell|zsh|fish|powershell|ps1|cmd|batch)$/i.test(language);
    const isOutput = /^(text|output|log|plain)$/i.test(language);

    if (!isOutput) {
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'code-action-btn code-action-apply';
      applyBtn.textContent = suggestedPath ? `Apply → ${suggestedPath.split('/').pop() ?? suggestedPath}` : 'Apply to File';
      applyBtn.title = suggestedPath ? `Apply to ${suggestedPath}` : 'Apply this code to a file in your workspace';
      applyBtn.addEventListener('click', () => {
        vscode.postMessage({
          type: 'applyFileEdit',
          code: rawCode,
          language,
          suggestedPath,
        });
      });
      actions.appendChild(applyBtn);
    }

    // Run in Terminal button (for shell blocks)
    if (isShell) {
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'code-action-btn code-action-run';
      runBtn.textContent = '▶ Run';
      runBtn.title = 'Run this command in the integrated terminal';
      runBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'runInTerminal', command: rawCode.trim() });
      });
      actions.appendChild(runBtn);
    }

    pre.appendChild(actions);
  });
}

const promptEl = getEl<HTMLTextAreaElement>('prompt');
const messagesEl = getEl<HTMLElement>('messages');
const emptyStateEl = getEl<HTMLElement>('emptyState');
const statusTextEl = getEl<HTMLElement>('statusText');
const statusPillEl = getEl<HTMLElement>('statusPill');
const sendBtn = getEl<HTMLButtonElement>('sendBtn');
const newChatBtn = getEl<HTMLButtonElement>('newChatBtn');
const refreshModelsBtn = getEl<HTMLButtonElement>('refreshModelsBtn');
const modelSelect = getEl<HTMLSelectElement>('modelSelect');
const providerSelect = getEl<HTMLSelectElement>('providerSelect');
const sessionBar = getEl<HTMLElement>('sessionBar');
const attachBtn = getEl<HTMLButtonElement>('attachBtn');
const browseBtn = getElOpt<HTMLButtonElement>('browseBtn');
const attachMenu = getEl<HTMLElement>('attachMenu');
const attachSearch = getEl<HTMLInputElement>('attachSearch');
const attachmentRow = getEl<HTMLElement>('attachmentRow');
const modeAgent = getEl<HTMLButtonElement>('modeAgent');
const modeAsk = getEl<HTMLButtonElement>('modeAsk');
const modePlan = getEl<HTMLButtonElement>('modePlan');
const settingsBtn = getEl<HTMLButtonElement>('settingsBtn');
const mainView = getEl<HTMLElement>('mainView');
const settingsOverlay = getEl<HTMLElement>('settingsOverlay');
const settingsCloseBtn = getEl<HTMLButtonElement>('settingsCloseBtn');
const settingsCancelBtn = getEl<HTMLButtonElement>('settingsCancelBtn');
const settingsSaveBtn = getEl<HTMLButtonElement>('settingsSaveBtn');
const settingsSavedToast = getEl<HTMLElement>('settingsSavedToast');
const inputOpenRouterKey = getEl<HTMLInputElement>('inputOpenRouterKey');
const inputHfKey = getEl<HTMLInputElement>('inputHfKey');
const inputTemperature = getEl<HTMLInputElement>('inputTemperature');
const inputMaxTokens = getEl<HTMLInputElement>('inputMaxTokens');
const inputTopP = getEl<HTMLInputElement>('inputTopP');
const chkOpenRouterFreeOnly = getEl<HTMLInputElement>('chkOpenRouterFreeOnly');
const orKeyHint = getEl<HTMLElement>('orKeyHint');
const hfKeyHint = getEl<HTMLElement>('hfKeyHint');
const settingsPanelInner = getEl<HTMLElement>('settingsPanelInner');
const toggleOrKey = getEl<HTMLButtonElement>('toggleOrKey');
const toggleHfKey = getEl<HTMLButtonElement>('toggleHfKey');
const selectFileAccess = getEl<HTMLSelectElement>('selectFileAccess');
const chkTerminalAccess = getEl<HTMLInputElement>('chkTerminalAccess');
const chkGitAccess = getEl<HTMLInputElement>('chkGitAccess');

settingsPanelInner.addEventListener('click', (event) => {
  event.stopPropagation();
});

let busy = false;
let pendingAssistantBubble: HTMLElement | null = null;
let pendingAssistantWrapper: HTMLElement | null = null;
let mode: ChatMode = 'agent';
let attachments: AttachmentChip[] = [];
let ignoreModelSelectChange = false;
let sessions: SessionTab[] = [];
let activeSessionId = '';

function setBusy(isBusy: boolean): void {
  busy = isBusy;
  refreshModelsBtn.toggleAttribute('disabled', isBusy);
  modelSelect.disabled = isBusy;
  providerSelect.disabled = isBusy;
  sendBtn.toggleAttribute('disabled', isBusy);
  newChatBtn.toggleAttribute('disabled', isBusy);
  settingsBtn.toggleAttribute('disabled', isBusy);
}

function setStatus(text: string): void {
  statusTextEl.textContent = text;
  if (text === 'Error') {
    statusPillEl.classList.add('error');
  } else {
    statusPillEl.classList.remove('error');
  }
}

function updateEmptyState(): void {
  emptyStateEl.style.display = messagesEl.children.length ? 'none' : 'flex';
}

function setModels(models: unknown, selectedModel: unknown): void {
  ignoreModelSelectChange = true;
  modelSelect.innerHTML = '';
  const safeModels = Array.isArray(models) ? models.map(String) : [];

  safeModels.forEach((modelName) => {
    const option = document.createElement('option');
    option.value = modelName;
    option.textContent = modelName;
    option.selected = modelName === selectedModel;
    modelSelect.appendChild(option);
  });

  if (!safeModels.length) {
    const option = document.createElement('option');
    option.value = String(selectedModel ?? '');
    option.textContent = String(selectedModel ?? 'No models found');
    option.selected = true;
    modelSelect.appendChild(option);
  } else {
    const sel = String(selectedModel ?? '');
    if ([...modelSelect.options].some((o) => o.value === sel)) {
      modelSelect.value = sel;
    }
  }

  ignoreModelSelectChange = false;
}

function renderSessionBar(): void {
  sessionBar.innerHTML = '';

  for (const s of sessions) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `session-tab${s.id === activeSessionId ? ' active' : ''}`;
    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = s.title;
    tab.appendChild(label);

    const rename = document.createElement('span');
    rename.className = 'session-rename';
    rename.setAttribute('role', 'button');
    rename.setAttribute('aria-label', 'Rename tab');
    rename.title = 'Rename';
    rename.textContent = '✎';
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'renameSession', id: s.id });
    });
    tab.appendChild(rename);

    tab.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchSession', id: s.id });
    });

    if (sessions.length > 1) {
      const close = document.createElement('span');
      close.className = 'session-close';
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', 'Close tab');
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'closeSession', id: s.id });
      });
      tab.appendChild(close);
    }

    sessionBar.appendChild(tab);
  }
}

function openSettingsPanel(): void {
  vscode.postMessage({ type: 'getSettings' });
}

function closeSettingsPanel(): void {
  settingsOverlay.classList.add('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'true');
  mainView.classList.remove('hidden');
}

function applySettingsForm(message: Record<string, unknown>): void {
  orKeyHint.textContent = message.hasOpenRouterKey ? '(saved)' : '';
  hfKeyHint.textContent = message.hasHuggingfaceKey ? '(saved)' : '';

  // Reset password fields (never prefill secrets)
  inputOpenRouterKey.value = '';
  inputOpenRouterKey.type = 'password';
  toggleOrKey.textContent = '👁';
  inputHfKey.value = '';
  inputHfKey.type = 'password';
  toggleHfKey.textContent = '👁';

  inputTemperature.value = String(message.temperature ?? 0.2);
  inputMaxTokens.value = String(message.maxTokens ?? 4096);
  inputTopP.value = String(message.topP ?? 1);
  chkOpenRouterFreeOnly.checked = Boolean(message.openRouterFreeOnly);
  selectFileAccess.value = String(message.fileAccess ?? 'none');
  chkTerminalAccess.checked = Boolean(message.terminalAccess);
  chkGitAccess.checked = Boolean(message.gitAccess);
  updateCapabilityBadges(String(message.fileAccess ?? 'none'), Boolean(message.terminalAccess), Boolean(message.gitAccess));

  // Clear any leftover validation state
  inputTemperature.classList.remove('invalid');
  inputTopP.classList.remove('invalid');
  inputMaxTokens.classList.remove('invalid');

  mainView.classList.add('hidden');
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'false');
}

function renderThread(msgs: ThreadMessage[]): void {
  messagesEl.innerHTML = '';
  pendingAssistantBubble = null;
  pendingAssistantWrapper = null;

  for (const m of msgs) {
    if (m.role === 'user') {
      createMessage('user', m.content);
    } else if (m.role === 'assistant') {
      const { bubble, wrapper } = createMessage('assistant', '');
      const { visible, thinking } = stripThinkingBlocks(m.content);
      if (thinking) {
        const thinkingBlock = document.createElement('div');
        thinkingBlock.className = 'thinking-block';
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'thinking-toggle-btn';
        toggleBtn.innerHTML = `<span class="thinking-toggle-arrow">▶</span> Reasoning`;
        thinkingBlock.appendChild(toggleBtn);
        const thinkingContent = document.createElement('div');
        thinkingContent.className = 'thinking-content';
        thinkingContent.textContent = thinking;
        thinkingBlock.appendChild(thinkingContent);
        toggleBtn.addEventListener('click', () => {
          const isOpen = thinkingContent.classList.toggle('visible');
          const arrow = toggleBtn.querySelector<HTMLElement>('.thinking-toggle-arrow');
          if (arrow) { arrow.textContent = isOpen ? '▼' : '▶'; }
        });
        wrapper.insertBefore(thinkingBlock, bubble);
      }
      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(visible || m.content);
      enhanceCodeBlocks(bubble);
    }
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateEmptyState();
}

function syncModeUi(): void {
  modeAgent.classList.toggle('active', mode === 'agent');
  modeAsk.classList.toggle('active', mode === 'ask');
  modePlan.classList.toggle('active', mode === 'plan');
}

function updateCapabilityBadges(fileAccess: string, terminalAccess: boolean, gitAccess: boolean): void {
  const capFile = getElOpt<HTMLElement>('capFile');
  const capEdit = getElOpt<HTMLElement>('capEdit');
  const capTerm = getElOpt<HTMLElement>('capTerm');
  const capGit = getElOpt<HTMLElement>('capGit');
  const capNav = getElOpt<HTMLElement>('capNav');

  if (capFile) {
    capFile.textContent = fileAccess === 'readwrite' ? 'Read+Write' : fileAccess === 'read' ? 'Read' : 'Off';
    capFile.className = 'cap-val' + (fileAccess !== 'none' ? ' cap-on' : '');
  }
  if (capEdit) {
    capEdit.textContent = fileAccess === 'readwrite' ? 'On' : 'Off';
    capEdit.className = 'cap-val' + (fileAccess === 'readwrite' ? ' cap-on' : '');
  }
  if (capNav) {
    capNav.textContent = fileAccess !== 'none' ? 'On' : 'Off';
    capNav.className = 'cap-val' + (fileAccess !== 'none' ? ' cap-on' : '');
  }
  if (capTerm) {
    capTerm.textContent = terminalAccess ? 'On' : 'Off';
    capTerm.className = 'cap-val' + (terminalAccess ? ' cap-on' : '');
  }
  if (capGit) {
    capGit.textContent = gitAccess ? 'On' : 'Off';
    capGit.className = 'cap-val' + (gitAccess ? ' cap-on' : '');
  }
}

function setMode(next: ChatMode): void {
  mode = next;
  syncModeUi();
}

function renderAttachmentRow(): void {
  attachmentRow.innerHTML = '';
  if (!attachments.length) {
    attachmentRow.classList.add('hidden');
    return;
  }
  attachmentRow.classList.remove('hidden');
  attachments.forEach((item) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const label = document.createElement('span');
    label.textContent = item.label;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove attachment');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeAttachment', id: item.id });
    });
    chip.appendChild(label);
    chip.appendChild(remove);
    attachmentRow.appendChild(chip);
  });
}

function createMessage(
  role: 'user' | 'assistant',
  plainText: string,
  isError = false
): { wrapper: HTMLElement; bubble: HTMLElement } {
  const wrapper = document.createElement('div');
  wrapper.className = `msg msg-${role}${isError ? ' error' : ''}`;

  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = role === 'user' ? 'You' : 'Assistant';

  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-plain';
  bubble.textContent = plainText;

  wrapper.appendChild(roleEl);
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateEmptyState();

  return { wrapper, bubble };
}

function submitPrompt(): void {
  const value = promptEl.value.trim();
  if (!value || busy) {
    return;
  }

  createMessage('user', value);
  vscode.postMessage({
    type: 'send',
    text: value,
    mode,
  });
  promptEl.value = '';
}

function closeMenus(): void {
  attachMenu.classList.remove('show');
}

function toggleAttachMenu(): void {
  const show = !attachMenu.classList.contains('show');
  closeMenus();
  if (show) {
    attachMenu.classList.add('show');
    attachSearch.value = '';
    attachSearch.focus();
  }
}

function filterAttachMenu(): void {
  const q = attachSearch.value.trim().toLowerCase();
  attachMenu.querySelectorAll<HTMLButtonElement>('.menu-item[data-filter]').forEach((btn) => {
    const t = (btn.dataset.filter ?? '').toLowerCase();
    btn.style.display = !q || t.includes(q) ? '' : 'none';
  });
}

sendBtn.addEventListener('click', () => {
  submitPrompt();
});

newChatBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'newSession' });
});

settingsBtn.addEventListener('click', () => {
  if (!settingsOverlay.classList.contains('hidden')) {
    closeSettingsPanel();
    return;
  }
  openSettingsPanel();
});

settingsCloseBtn.addEventListener('click', () => {
  closeSettingsPanel();
});

settingsCancelBtn.addEventListener('click', () => {
  closeSettingsPanel();
});

settingsOverlay.addEventListener('click', (event) => {
  if (event.target === settingsOverlay) {
    closeSettingsPanel();
  }
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validateSettingsInputs(): boolean {
  let valid = true;
  const tempVal = Number(inputTemperature.value);
  if (!Number.isFinite(tempVal) || tempVal < 0 || tempVal > 2) {
    inputTemperature.classList.add('invalid');
    valid = false;
  } else {
    inputTemperature.classList.remove('invalid');
  }
  const topPVal = Number(inputTopP.value);
  if (!Number.isFinite(topPVal) || topPVal < 0.01 || topPVal > 1) {
    inputTopP.classList.add('invalid');
    valid = false;
  } else {
    inputTopP.classList.remove('invalid');
  }
  const maxTokVal = Number(inputMaxTokens.value);
  if (!Number.isFinite(maxTokVal) || maxTokVal < 1 || maxTokVal > 128000) {
    inputMaxTokens.classList.add('invalid');
    valid = false;
  } else {
    inputMaxTokens.classList.remove('invalid');
  }
  return valid;
}

let toastTimer: number | undefined;

function showSavedToast(): void {
  settingsSavedToast.classList.add('visible');
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    settingsSavedToast.classList.remove('visible');
    toastTimer = undefined;
  }, 1800);
}

function togglePasswordVisibility(input: HTMLInputElement, btn: HTMLButtonElement): void {
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.textContent = isHidden ? '🙈' : '👁';
}

toggleOrKey.addEventListener('click', () => {
  togglePasswordVisibility(inputOpenRouterKey, toggleOrKey);
});

toggleHfKey.addEventListener('click', () => {
  togglePasswordVisibility(inputHfKey, toggleHfKey);
});

settingsSaveBtn.addEventListener('click', () => {
  if (!validateSettingsInputs()) {
    return;
  }
  const temperature = clamp(Number(inputTemperature.value), 0, 2);
  const maxTokens = clamp(Math.round(Number(inputMaxTokens.value)), 1, 128000);
  const topP = clamp(Number(inputTopP.value), 0.01, 1);
  vscode.postMessage({
    type: 'saveSettings',
    openRouterKey: inputOpenRouterKey.value.trim() || undefined,
    huggingfaceKey: inputHfKey.value.trim() || undefined,
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
    topP: Number.isFinite(topP) ? topP : undefined,
    openRouterFreeOnly: chkOpenRouterFreeOnly.checked,
    fileAccess: selectFileAccess.value,
    terminalAccess: chkTerminalAccess.checked,
    gitAccess: chkGitAccess.checked,
  });
  showSavedToast();
  window.setTimeout(() => {
    closeSettingsPanel();
  }, 900);
});

refreshModelsBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'getModels' });
});

providerSelect.addEventListener('change', () => {
  vscode.postMessage({
    type: 'setProvider',
    provider: providerSelect.value,
  });
});

modelSelect.addEventListener('change', () => {
  if (ignoreModelSelectChange) {
    return;
  }
  vscode.postMessage({
    type: 'setModel',
    model: modelSelect.value,
  });
});

promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});

attachBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleAttachMenu();
});

browseBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'openBrowser' });
});

// Drag & drop files onto chat area
messagesEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  messagesEl.classList.add('drag-over');
});
messagesEl.addEventListener('dragleave', () => {
  messagesEl.classList.remove('drag-over');
});
messagesEl.addEventListener('drop', (event) => {
  event.preventDefault();
  messagesEl.classList.remove('drag-over');
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    vscode.postMessage({ type: 'pickLocalFile' });
  }
});

document.addEventListener('click', () => {
  closeMenus();
});

attachMenu.addEventListener('click', (event) => {
  event.stopPropagation();
});

attachSearch.addEventListener('input', () => {
  filterAttachMenu();
});

attachMenu.querySelectorAll<HTMLButtonElement>('.menu-item[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    closeMenus();
    if (action === 'activeFile') {
      vscode.postMessage({ type: 'attachActiveFile' });
    } else if (action === 'openEditors') {
      vscode.postMessage({ type: 'pickOpenEditor' });
    } else if (action === 'workspaceFile') {
      vscode.postMessage({ type: 'pickWorkspaceFile' });
    } else if (action === 'problems') {
      vscode.postMessage({ type: 'attachProblems' });
    } else if (action === 'clipboardImage') {
      vscode.postMessage({ type: 'attachClipboardImage' });
    } else if (action === 'localFile') {
      vscode.postMessage({ type: 'pickLocalFile' });
    } else if (action === 'instructions') {
      vscode.postMessage({ type: 'stub', feature: 'instructions' });
    } else if (action === 'symbols') {
      vscode.postMessage({ type: 'stub', feature: 'symbols' });
    }
  });
});

modeAgent.addEventListener('click', () => {
  setMode('agent');
});
modeAsk.addEventListener('click', () => {
  setMode('ask');
});
modePlan.addEventListener('click', () => {
  setMode('plan');
});

window.addEventListener('message', (event) => {
  const message = event.data as Record<string, unknown>;

  if (message?.type === 'status') {
    setStatus(String(message.status ?? ''));
    return;
  }

  if (message?.type === 'sessionState') {
    activeSessionId = String(message.activeSessionId ?? '');
    const raw = message.sessions;
    sessions = Array.isArray(raw)
      ? raw.map((item) => {
          const o = item as Record<string, unknown>;
          return {
            id: String(o.id ?? ''),
            title: String(o.title ?? 'Chat'),
          };
        })
      : [];
    renderSessionBar();
    return;
  }

  if (message?.type === 'providerChanged') {
    const p = String(message.provider ?? 'ollama');
    if (providerSelect.value !== p) {
      providerSelect.value = p;
    }
    return;
  }

  if (message?.type === 'settingsForm') {
    applySettingsForm(message);
    return;
  }

  if (message?.type === 'loadThread') {
    const raw = message.messages;
    const msgs: ThreadMessage[] = Array.isArray(raw)
      ? raw.map((item) => {
          const o = item as Record<string, unknown>;
          return {
            role: String(o.role ?? 'user'),
            content: String(o.content ?? ''),
          };
        })
      : [];
    renderThread(msgs);
    promptEl.focus();
    return;
  }

  if (message?.type === 'assistantStart') {
    setBusy(true);
    if (pendingAssistantWrapper) {
      pendingAssistantWrapper.remove();
      pendingAssistantBubble = null;
      pendingAssistantWrapper = null;
    }
    const { wrapper, bubble } = createMessage('assistant', '');
    bubble.className = 'bubble bubble-thinking';
    bubble.innerHTML = SPINNER_HTML;
    pendingAssistantBubble = bubble;
    pendingAssistantWrapper = wrapper;
    return;
  }

  if (message?.type === 'assistantAbort') {
    setBusy(false);
    if (pendingAssistantBubble && pendingAssistantWrapper) {
      pendingAssistantBubble.textContent = 'Stopped.';
      pendingAssistantWrapper.classList.remove('error');
      pendingAssistantBubble = null;
      pendingAssistantWrapper = null;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  if (message?.type === 'assistantDelta') {
    if (pendingAssistantBubble) {
      const raw = String(message.text ?? '');
      const { visible } = stripThinkingBlocks(raw);
      if (visible) {
        pendingAssistantBubble.className = 'bubble md';
        pendingAssistantBubble.innerHTML = renderMarkdown(visible);
      } else {
        // Still in thinking phase — keep spinner
        pendingAssistantBubble.className = 'bubble bubble-thinking';
        pendingAssistantBubble.innerHTML = SPINNER_HTML;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return;
  }

  if (message?.type === 'assistantDone') {
    setBusy(false);
    const text = String(message.text ?? '');
    const { visible, thinking } = stripThinkingBlocks(text);

    const finalize = (bubble: HTMLElement, wrapper: HTMLElement): void => {
      // Inject thinking toggle above the main answer if there was reasoning
      if (thinking) {
        const thinkingBlock = document.createElement('div');
        thinkingBlock.className = 'thinking-block';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'thinking-toggle-btn';
        toggleBtn.innerHTML = `<span class="thinking-toggle-arrow">▶</span> Reasoning`;
        thinkingBlock.appendChild(toggleBtn);

        const thinkingContent = document.createElement('div');
        thinkingContent.className = 'thinking-content';
        thinkingContent.textContent = thinking;
        thinkingBlock.appendChild(thinkingContent);

        toggleBtn.addEventListener('click', () => {
          const isOpen = thinkingContent.classList.toggle('visible');
          const arrow = toggleBtn.querySelector<HTMLElement>('.thinking-toggle-arrow');
          if (arrow) {
            arrow.textContent = isOpen ? '▼' : '▶';
          }
        });

        wrapper.insertBefore(thinkingBlock, bubble);
      }

      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(visible || '*(no response)*');
      enhanceCodeBlocks(bubble);
    };

    if (pendingAssistantBubble && pendingAssistantWrapper) {
      finalize(pendingAssistantBubble, pendingAssistantWrapper);
      pendingAssistantBubble = null;
      pendingAssistantWrapper = null;
    } else {
      const { bubble, wrapper } = createMessage('assistant', '');
      finalize(bubble, wrapper);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    promptEl.focus();
    return;
  }

  if (message?.type === 'assistantError') {
    setBusy(false);
    const text = String(message.text ?? '');
    if (pendingAssistantBubble && pendingAssistantWrapper) {
      pendingAssistantBubble.textContent = text;
      pendingAssistantBubble.className = 'bubble bubble-plain';
      pendingAssistantWrapper.classList.add('error');
      pendingAssistantBubble = null;
      pendingAssistantWrapper = null;
    } else {
      createMessage('assistant', text, true);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    promptEl.focus();
    return;
  }

  if (message?.type === 'cleared') {
    messagesEl.innerHTML = '';
    pendingAssistantBubble = null;
    pendingAssistantWrapper = null;
    updateEmptyState();
    return;
  }

  if (message?.type === 'models') {
    setModels(message.models, message.selectedModel);
    return;
  }

  if (message?.type === 'modelChanged') {
    ignoreModelSelectChange = true;
    modelSelect.value = String(message.model ?? '');
    ignoreModelSelectChange = false;
    return;
  }

  if (message?.type === 'attachmentsUpdated') {
    const raw = message.items;
    attachments = Array.isArray(raw)
      ? raw.map((item) => {
          const o = item as Record<string, unknown>;
          return {
            id: String(o.id ?? ''),
            label: String(o.label ?? ''),
          };
        })
      : [];
    renderAttachmentRow();
  }

  if (message?.type === 'workspaceTree') {
    const tree = String(message.tree ?? '');
    const { bubble } = createMessage('assistant', '');
    bubble.className = 'bubble md';
    bubble.innerHTML = renderMarkdown('```\n' + tree + '\n```');
    enhanceCodeBlocks(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateEmptyState();
    return;
  }

  if (message?.type === 'gitResult') {
    const output = String(message.output ?? '');
    const op = String(message.op ?? '');
    const { bubble } = createMessage('assistant', '');
    bubble.className = 'bubble md';
    bubble.innerHTML = renderMarkdown(`**Git ${op}**\n\`\`\`\n${output}\n\`\`\``);
    enhanceCodeBlocks(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateEmptyState();
    return;
  }

  if (message?.type === 'ollamaState') {
    const state = String(message.state ?? '');
    if (state === 'not-running') {
      setStatus('Ollama not running');
      statusPillEl.classList.add('error');
    } else if (state === 'not-installed') {
      setStatus('Ollama not installed');
      statusPillEl.classList.add('error');
    } else if (state === 'running') {
      const ver = message.version ? ` v${String(message.version)}` : '';
      setStatus(`Idle — Ollama${ver}`);
      statusPillEl.classList.remove('error');
    }
    return;
  }

  if (message?.type === 'browserSelection') {
    const text = String(message.text ?? '');
    const url = String(message.url ?? '');
    const tag = message.elementTag ? ` <${String(message.elementTag)}>` : '';
    const { bubble } = createMessage('assistant', '');
    bubble.className = 'bubble md';
    bubble.innerHTML = renderMarkdown(
      `**📎 Web selection from** \`${url}\`${tag}\n\n> ${text.replace(/\n/g, '\n> ')}`
    );
    enhanceCodeBlocks(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateEmptyState();
    if (!promptEl.value) {
      try {
        const hostname = new URL(url).hostname;
        promptEl.value = `About this from ${hostname}: `;
      } catch {
        promptEl.value = 'About this: ';
      }
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    }
    return;
  }
});

syncModeUi();
updateEmptyState();
promptEl.focus();
vscode.postMessage({ type: 'getModels' });
