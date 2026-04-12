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

function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

function enhanceCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code-btn')) {
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      void navigator.clipboard.writeText(code?.textContent ?? '');
      btn.textContent = 'Copied';
      window.setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1400);
    });
    pre.appendChild(btn);
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
const attachMenu = getEl<HTMLElement>('attachMenu');
const attachSearch = getEl<HTMLInputElement>('attachSearch');
const attachmentRow = getEl<HTMLElement>('attachmentRow');
const modeAgent = getEl<HTMLButtonElement>('modeAgent');
const modeAsk = getEl<HTMLButtonElement>('modeAsk');
const modePlan = getEl<HTMLButtonElement>('modePlan');
const settingsBtn = getEl<HTMLButtonElement>('settingsBtn');
const settingsOverlay = getEl<HTMLElement>('settingsOverlay');
const settingsCloseBtn = getEl<HTMLButtonElement>('settingsCloseBtn');
const settingsCancelBtn = getEl<HTMLButtonElement>('settingsCancelBtn');
const settingsSaveBtn = getEl<HTMLButtonElement>('settingsSaveBtn');
const inputOpenRouterKey = getEl<HTMLInputElement>('inputOpenRouterKey');
const inputHfKey = getEl<HTMLInputElement>('inputHfKey');
const inputTemperature = getEl<HTMLInputElement>('inputTemperature');
const inputMaxTokens = getEl<HTMLInputElement>('inputMaxTokens');
const inputTopP = getEl<HTMLInputElement>('inputTopP');
const chkOpenRouterFreeOnly = getEl<HTMLInputElement>('chkOpenRouterFreeOnly');
const orKeyHint = getEl<HTMLElement>('orKeyHint');
const hfKeyHint = getEl<HTMLElement>('hfKeyHint');
const settingsPanelInner = getEl<HTMLElement>('settingsPanelInner');

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
}

function applySettingsForm(message: Record<string, unknown>): void {
  orKeyHint.textContent = message.hasOpenRouterKey ? '(saved)' : '';
  hfKeyHint.textContent = message.hasHuggingfaceKey ? '(saved)' : '';
  inputOpenRouterKey.value = '';
  inputHfKey.value = '';
  inputTemperature.value = String(message.temperature ?? 0.2);
  inputMaxTokens.value = String(message.maxTokens ?? 4096);
  inputTopP.value = String(message.topP ?? 1);
  chkOpenRouterFreeOnly.checked = Boolean(message.openRouterFreeOnly);
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
      const { bubble } = createMessage('assistant', '');
      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(m.content);
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

settingsSaveBtn.addEventListener('click', () => {
  const temperature = Number(inputTemperature.value);
  const maxTokens = Number(inputMaxTokens.value);
  const topP = Number(inputTopP.value);
  vscode.postMessage({
    type: 'saveSettings',
    openRouterKey: inputOpenRouterKey.value.trim() || undefined,
    huggingfaceKey: inputHfKey.value.trim() || undefined,
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
    topP: Number.isFinite(topP) ? topP : undefined,
    openRouterFreeOnly: chkOpenRouterFreeOnly.checked,
  });
  closeSettingsPanel();
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
    const { wrapper, bubble } = createMessage('assistant', '…');
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
      pendingAssistantBubble.textContent = String(message.text ?? '');
      pendingAssistantBubble.className = 'bubble bubble-plain';
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return;
  }

  if (message?.type === 'assistantDone') {
    setBusy(false);
    const text = String(message.text ?? '');
    if (pendingAssistantBubble) {
      pendingAssistantBubble.className = 'bubble md';
      pendingAssistantBubble.innerHTML = renderMarkdown(text);
      enhanceCodeBlocks(pendingAssistantBubble);
      pendingAssistantBubble = null;
      pendingAssistantWrapper = null;
    } else {
      const { bubble } = createMessage('assistant', '');
      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(text);
      enhanceCodeBlocks(bubble);
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
});

syncModeUi();
updateEmptyState();
promptEl.focus();
vscode.postMessage({ type: 'getModels' });
