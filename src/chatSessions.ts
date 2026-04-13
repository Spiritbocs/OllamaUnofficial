import type * as vscode from 'vscode';

export type PersistedMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  archived?: boolean;
  messages: PersistedMessage[];
};

const SESSIONS_KEY = 'ollamaCoderChat.sessions.v2';
const ACTIVE_KEY = 'ollamaCoderChat.activeSessionId.v2';
export const MAX_SESSIONS = 24;

export function randomId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function truncateTitle(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) {
    return one || 'New chat';
  }
  return `${one.slice(0, max - 1)}…`;
}

export function loadSessions(globalState: vscode.Memento): {
  sessions: ChatSession[];
  activeSessionId: string;
} {
  try {
    const raw = globalState.get<string>(SESSIONS_KEY);
    const sessions = raw
      ? (JSON.parse(raw) as ChatSession[]).filter(
          (s) => s && typeof s.id === 'string' && Array.isArray(s.messages)
        )
      : [];

    for (const session of sessions) {
      session.archived = Boolean(session.archived);
    }

    let activeSessionId = globalState.get<string>(ACTIVE_KEY) ?? '';

    if (!sessions.length) {
      const id = randomId();
      sessions.push({ id, title: 'New chat', updatedAt: Date.now(), messages: [] });
      activeSessionId = id;
    }

    if (!sessions.some((s) => s.id === activeSessionId)) {
      activeSessionId = sessions[0]?.id ?? '';
    }

    return { sessions, activeSessionId };
  } catch {
    const id = randomId();
    return {
      sessions: [{ id, title: 'New chat', updatedAt: Date.now(), messages: [] }],
      activeSessionId: id,
    };
  }
}

export function saveSessions(
  globalState: vscode.Memento,
  sessions: ChatSession[],
  activeSessionId: string
): Thenable<void> {
  const trimmed = sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);

  return Promise.all([
    globalState.update(SESSIONS_KEY, JSON.stringify(trimmed)),
    globalState.update(ACTIVE_KEY, activeSessionId),
  ]).then(() => undefined);
}

export function upsertSessionTitleFromMessages(session: ChatSession): void {
  if (session.title !== 'New chat') {
    return;
  }

  const firstUser = session.messages.find((m) => m.role === 'user');

  if (firstUser?.content) {
    const head = firstUser.content.split('\n')[0] ?? firstUser.content;
    session.title = truncateTitle(head);
  }
}
