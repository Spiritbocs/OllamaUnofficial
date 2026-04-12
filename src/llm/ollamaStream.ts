type OllamaChatPayload = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
  };
};

function composeDisplay(textBuf: string, thinkingBuf: string, toolJson: string | undefined): string {
  const thinkingBlock =
    thinkingBuf.trim().length > 0
      ? `### Reasoning\n${thinkingBuf.trim()}\n\n### Answer\n`
      : '';
  const toolBlock =
    toolJson && toolJson.length > 0
      ? `\n\n---\n\n_Model output included tool calls (not executed by the extension):_\n\n\`\`\`json\n${toolJson}\n\`\`\`\n`
      : '';
  return `${thinkingBlock}${textBuf}${toolBlock}`;
}

/**
 * Reads an Ollama /api/chat NDJSON stream. Handles incremental `content`, optional
 * `thinking` streams, and `tool_calls` when models return no plain text.
 */
export async function streamOllamaChat(args: {
  baseUrl: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  signal: AbortSignal;
  onDelta: (displayText: string) => void;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}): Promise<string> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/api/chat`;
  const body: OllamaChatPayload = {
    model: args.model,
    stream: true,
    messages: args.messages,
    options: buildOllamaOptions(args),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: args.signal,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText} ${errorText}`);
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('Ollama returned an empty response body.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let textBuf = '';
  let thinkingBuf = '';
  let lastToolJson: string | undefined;

  const flush = () => {
    args.onDelta(composeDisplay(textBuf, thinkingBuf, lastToolJson));
  };

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      let data: Record<string, unknown>;

      try {
        data = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof data.error === 'string') {
        throw new Error(data.error);
      }

      const message = data.message as Record<string, unknown> | undefined;

      if (!message) {
        continue;
      }

      if (typeof message.content === 'string' && message.content.length > 0) {
        textBuf += message.content;
      }

      const thinking = message.thinking;

      if (typeof thinking === 'string' && thinking.length > 0) {
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
      const data = JSON.parse(tail) as Record<string, unknown>;

      if (typeof data.error === 'string') {
        throw new Error(data.error);
      }

      const message = data.message as Record<string, unknown> | undefined;

      if (message) {
        if (typeof message.content === 'string' && message.content.length > 0) {
          textBuf += message.content;
        }

        const thinking = message.thinking;

        if (typeof thinking === 'string' && thinking.length > 0) {
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
      /* ignore trailing parse noise */
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
    topP: args.topP,
  });
}

function buildOllamaOptions(args: {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}): OllamaChatPayload['options'] {
  const options: NonNullable<OllamaChatPayload['options']> = {};

  if (typeof args.temperature === 'number' && !Number.isNaN(args.temperature)) {
    options.temperature = args.temperature;
  }

  if (typeof args.topP === 'number' && !Number.isNaN(args.topP)) {
    options.top_p = args.topP;
  }

  if (typeof args.maxTokens === 'number' && !Number.isNaN(args.maxTokens) && args.maxTokens > 0) {
    options.num_predict = Math.floor(args.maxTokens);
  }

  return Object.keys(options).length ? options : undefined;
}

async function ollamaChatNonStream(args: {
  baseUrl: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}): Promise<string> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/api/chat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      stream: false,
      messages: args.messages,
      options: buildOllamaOptions(args),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} (non-stream fallback) ${errorText}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string; tool_calls?: unknown[]; thinking?: string };
    error?: string;
  };

  if (data.error) {
    throw new Error(data.error);
  }

  const msg = data.message;
  let text = msg?.content?.trim() ?? '';
  const thinking = typeof msg?.thinking === 'string' ? msg.thinking : '';
  const toolCalls = msg?.tool_calls;

  if ((!text || text.length === 0) && Array.isArray(toolCalls) && toolCalls.length > 0) {
    text = `Tool calls (not executed):\n\`\`\`json\n${JSON.stringify(toolCalls, null, 2)}\n\`\`\``;
  }

  if (thinking.trim().length > 0) {
    text = `### Reasoning\n${thinking.trim()}\n\n### Answer\n${text}`;
  }

  if (!text.trim()) {
    throw new Error('Ollama returned an empty response (stream and non-stream).');
  }

  return text;
}
