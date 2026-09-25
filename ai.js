const config = require('./config');

class AiError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = !!retryable;
  }
}

function friendlyUpstreamMessage(status, raw) {
  if (status === 401 || status === 403) return 'The AI service rejected our credentials.';
  if (status === 402) return 'The AI service account is out of credit.';
  if (status === 429) return 'The AI service is busy right now.';
  if (status >= 500) return 'The AI service is having trouble right now.';
  return raw || `AI request failed (${status}).`;
}

// Streams one chat completion from an OpenAI-compatible API and returns the
// full text. onDelta(textSoFar) fires as tokens arrive so callers can report
// progress. Thinking/reasoning tokens (DeepSeek's reasoning_content) are
// ignored — only the answer text is returned.
async function streamChat({ messages, jsonMode = true, maxTokens, temperature = 0.4, onDelta, signal }) {
  if (!config.ai.apiKey) {
    throw new AiError('The AI service is not configured on the server.', { status: 500 });
  }

  const body = {
    model: config.ai.model,
    messages,
    stream: true,
    max_tokens: maxTokens || config.ai.maxOutputTokens,
    temperature
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (config.ai.disableThinking) body.thinking = { type: 'disabled' };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  // Hard ceiling so a stuck upstream can never hold a request open forever.
  const timeout = setTimeout(() => controller.abort(), 180000);

  let res;
  try {
    res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${config.ai.apiKey}`,
        'HTTP-Referer': config.publicUrl,
        'X-Title': 'DocGen AI'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw new AiError('Cancelled.', { status: 499 });
    throw new AiError('Could not reach the AI service.', { status: 502, retryable: true });
  }

  if (!res.ok || !res.body) {
    let raw = '';
    try {
      const data = await res.json();
      raw = data?.error?.message || '';
    } catch { /* not JSON */ }
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    // Some OpenAI-compatible models reject response_format — one retry
    // without it is cheaper than failing the user's request.
    if (jsonMode && res.status === 400 && /response_format|json/i.test(raw)) {
      return streamChat({ messages, jsonMode: false, maxTokens, temperature, onDelta, signal });
    }
    console.error(`[ai] upstream ${res.status}: ${raw}`);
    throw new AiError(friendlyUpstreamMessage(res.status, raw), {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.error) {
          throw new AiError(json.error.message || 'The AI service returned an error.', { status: 502, retryable: true });
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          onDelta?.(text);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (signal?.aborted) throw new AiError('Cancelled.', { status: 499 });
    throw new AiError('The connection to the AI service dropped.', { status: 502, retryable: true });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }

  return { text, finishReason };
}

module.exports = { streamChat, AiError };
