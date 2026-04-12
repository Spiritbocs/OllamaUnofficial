type ChatMessage = { role: string; content: string };

/**
 * OpenAI-compatible streaming (SSE): OpenRouter, Hugging Face router, etc.
 */
export async function streamOpenAiCompatibleChat(args: {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (fullText: string) => void;
  extraHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}): Promise<string> {
  const response = await fetch(args.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
      Accept: 'text/event-stream',
      ...args.extraHeaders,
    },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: true,
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      top_p: args.topP,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText} ${errorText}`);
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('Empty response body.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let textBuf = '';
  let reasoningBuf = '';

  const compose = () => {
    const r = reasoningBuf.trim();
    args.onDelta(
      r.length > 0 ? `### Reasoning\n${r}\n\n### Answer\n${textBuf}` : textBuf
    );
  };

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');

    let idx = buffer.indexOf('\n\n');

    while (idx !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');

      const lines = rawEvent.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const payload = trimmed.slice('data:'.length).trim();

        if (payload === '[DONE]') {
          compose();
          const out = (reasoningBuf.trim().length > 0
            ? `### Reasoning\n${reasoningBuf.trim()}\n\n### Answer\n${textBuf}`
            : textBuf
          ).trim();

          if (!out) {
            throw new Error('Model returned an empty streamed response.');
          }

          return reasoningBuf.trim().length > 0
            ? `### Reasoning\n${reasoningBuf.trim()}\n\n### Answer\n${textBuf}`
            : textBuf;
        }

        let data: Record<string, unknown>;

        try {
          data = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (typeof data.error === 'string') {
          throw new Error(data.error);
        }

        if (typeof data.error === 'object' && data.error !== null) {
          const err = data.error as { message?: string };
          throw new Error(err.message ?? JSON.stringify(data.error));
        }

        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        const choice0 = choices?.[0] as Record<string, unknown> | undefined;
        const delta = choice0?.delta as Record<string, unknown> | undefined;

        if (delta) {
          const c = delta.content;

          if (typeof c === 'string' && c.length > 0) {
            textBuf += c;
          }

          const r =
            (delta.reasoning as string | undefined) ??
            (delta.reasoning_content as string | undefined);

          if (typeof r === 'string' && r.length > 0) {
            reasoningBuf += r;
          }
        }

        compose();
      }
    }
  }

  compose();
  const out = (reasoningBuf.trim().length > 0
    ? `### Reasoning\n${reasoningBuf.trim()}\n\n### Answer\n${textBuf}`
    : textBuf
  ).trim();

  if (!out) {
    throw new Error('Model returned an empty streamed response.');
  }

  return reasoningBuf.trim().length > 0
    ? `### Reasoning\n${reasoningBuf.trim()}\n\n### Answer\n${textBuf}`
    : textBuf;
}

export async function openAiNonStream(args: {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  extraHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}): Promise<string> {
  const response = await fetch(args.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
      ...args.extraHeaders,
    },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: false,
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      top_p: args.topP,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  const text = data.choices?.[0]?.message?.content?.trim() ?? '';

  if (!text) {
    throw new Error('Empty non-stream response.');
  }

  return text;
}
