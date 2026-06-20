import Anthropic from '@anthropic-ai/sdk';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL || process.env.MODEL || 'deepseek-v4-flash';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || '';
const CHUNK_CHARS = Math.max(500, parseInt(process.env.CHUNK_CHARS || '3000', 10));

// DeepSeek's native OpenAI-compatible base (strip any /anthropic suffix from the configured URL).
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic')
  .replace(/\/anthropic\/?$/, '') || 'https://api.deepseek.com';

const USE_DEEPSEEK = !!DEEPSEEK_KEY;

export const DEFAULTS = {
  sourceLang: process.env.SOURCE_LANG || 'російської',
  targetLang: process.env.TARGET_LANG || 'українською',
  model: MODEL,
};
export const hasKey = !!(DEEPSEEK_KEY || ANTHROPIC_KEY);

// Anthropic SDK client is only used when running against real Anthropic (no DeepSeek key).
const anthropicClient = (!USE_DEEPSEEK && ANTHROPIC_KEY)
  ? new Anthropic({ apiKey: ANTHROPIC_KEY, ...(ANTHROPIC_BASE ? { baseURL: ANTHROPIC_BASE } : {}) })
  : null;

export function chunkText(text, budget = CHUNK_CHARS) {
  const paragraphs = text.split(/(\n\s*\n)/);
  const chunks = [];
  let current = '';
  for (const part of paragraphs) {
    if (current.length + part.length > budget && current.trim().length > 0) {
      chunks.push(current);
      current = '';
    }
    if (part.length > budget) {
      const pieces = part.match(new RegExp(`[\\s\\S]{1,${budget}}`, 'g')) || [part];
      for (const piece of pieces) {
        if (current.trim().length) { chunks.push(current); current = ''; }
        chunks.push(piece);
      }
      continue;
    }
    current += part;
  }
  if (current.trim().length) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
}

function buildSystem(sourceLang, targetLang, glossary) {
  let s =
    `Ти професійний перекладач. Перекладай з ${sourceLang} ${targetLang}. ` +
    `Зберігай авторський стиль, тон, розбивку на абзаци та порядок речень. ` +
    `Зберігай власні назви, імена, терміни і форматування. ` +
    `Нічого не скорочуй, не додавай і не коментуй — повертай ВИКЛЮЧНО переклад, без преамбул.`;
  if (glossary && glossary.trim()) {
    s += `\n\nДотримуйся глосарія (формат "оригінал = переклад", по одному на рядок):\n` + glossary.trim();
  }
  return s;
}

function isRetryable(status) {
  return status === 429 || (status >= 500 && status < 600) || !status;
}

// DeepSeek via the native OpenAI-compatible /chat/completions endpoint (stable, no SSE quirks).
async function translateChunkDeepSeek(text, system, attempt = 0) {
  try {
    const r = await fetch(DEEPSEEK_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
        temperature: 0.2,
        max_tokens: 8000,
        stream: false,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw Object.assign(new Error('DeepSeek ' + r.status + ': ' + body.slice(0, 300)), { status: r.status });
    }
    const data = await r.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  } catch (err) {
    const status = err?.status || err?.statusCode;
    if (isRetryable(status) && attempt < 4) {
      await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt)));
      return translateChunkDeepSeek(text, system, attempt + 1);
    }
    throw err;
  }
}

// Real Anthropic Claude via the SDK (streaming).
async function translateChunkAnthropic(text, system, attempt = 0) {
  try {
    let out = '';
    const stream = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: text }],
      stream: true,
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        out += ev.delta.text;
      }
    }
    return out;
  } catch (err) {
    const status = err?.status || err?.statusCode;
    if (isRetryable(status) && attempt < 4) {
      await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt)));
      return translateChunkAnthropic(text, system, attempt + 1);
    }
    throw err;
  }
}

const translateChunk = USE_DEEPSEEK ? translateChunkDeepSeek : translateChunkAnthropic;

/** Translate text, emitting {start|progress|done} events via onEvent. Returns full text. */
export async function runTranslation({ text, sourceLang, targetLang, glossary }, onEvent) {
  if (!hasKey) throw Object.assign(new Error('API-ключ не налаштовано'), { status: 500 });
  const system = buildSystem(sourceLang || DEFAULTS.sourceLang, targetLang || DEFAULTS.targetLang, glossary);
  const chunks = chunkText(text);
  const total = chunks.length;
  onEvent({ type: 'start', total });
  const parts = [];
  for (let i = 0; i < total; i++) {
    const translated = await translateChunk(chunks[i], system);
    parts.push(translated);
    onEvent({
      type: 'progress', index: i, done: i + 1, total,
      percent: Math.round(((i + 1) / total) * 100), translated,
    });
  }
  const full = parts.join('');
  onEvent({ type: 'done', text: full });
  return full;
}

/** Fetch DeepSeek account balance. Returns API JSON, or { unsupported:true } if not a DeepSeek key. */
export async function getBalance() {
  if (!DEEPSEEK_KEY) return { unsupported: true };
  const r = await fetch(DEEPSEEK_BASE + '/user/balance', {
    headers: { Authorization: 'Bearer ' + DEEPSEEK_KEY, Accept: 'application/json' },
  });
  if (!r.ok) throw Object.assign(new Error('balance http ' + r.status), { status: r.status });
  return await r.json();
}

export function friendlyError(err) {
  const status = err?.status || err?.statusCode || 500;
  if (status === 401) return 'Невірний API-ключ (401).';
  if (status === 402) return 'Недостатньо коштів на балансі провайдера (402).';
  if (status === 429) return 'Перевищено ліміт запитів (429). Спробуй пізніше.';
  return `Помилка перекладу (${status}): ${err?.message || 'невідома'}`;
}
