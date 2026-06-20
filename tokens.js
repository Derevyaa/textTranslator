const TOKENIZER_URL = (process.env.TOKENIZER_URL || '').replace(/\/$/, '');
export const tokenizerEnabled = !!TOKENIZER_URL;

/** Count tokens for a text via the tokenizer service. Returns number or null on any failure. */
export async function countTokens(text) {
  if (!TOKENIZER_URL || !text) return null;
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(15000)
      : undefined;
    const r = await fetch(TOKENIZER_URL + '/count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.tokens === 'number' ? d.tokens : null;
  } catch {
    return null;
  }
}
