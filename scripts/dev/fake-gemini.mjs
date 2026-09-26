// Deterministic stand-in for the Gemini API (local development and tests only).
// Speaks the REST shape the official SDK uses, counts every call, and plays a
// scripted outcome so tests can prove what did or did not reach the provider.
//
//   node scripts/dev/fake-gemini.mjs            (port 8790)
//   GET  /__calls   -> { count_tokens, generate_content, last_models }
//   POST /__control -> { mode, delay_ms?, output_tokens?, tags? }
//   POST /__reset
// Modes: ok | timeout | reject_400 | quota_429 | server_500 | overcharge | invalid_output
// A request whose text starts the item-tags prompt ("bowr:item_tags") gets the
// `tags` object (a default shirt unless set); others get {"ok":true}.
import http from 'node:http';

const PORT = Number(process.env.FAKE_GEMINI_PORT ?? 8790);
const DEFAULT_TAGS = {
  category: 'tops',
  category_confidence: 'high',
  subcategory: 'shirt',
  pattern: 'solid',
  material: 'cotton',
  formality: 2,
  seasons: ['hot', 'mild'],
  style_tags: ['minimal'],
};
let calls = { count_tokens: 0, generate_content: 0, last_models: [], last_had_image: false };
let control = { mode: 'ok', delay_ms: 0, output_tokens: 5, tags: DEFAULT_TAGS };

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
// Text counts about four characters per token; each inline image counts 258
// tokens (the provider's flat small-image rate), not its base64 length.
function countRequest(raw) {
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return { tokens: Math.max(1, Math.ceil(raw.length / 4)), text: raw, image: false };
  }
  const parts = (body.contents ?? body.generateContentRequest?.contents ?? []).flatMap((c) => c.parts ?? []);
  const text = parts.map((p) => p.text ?? '').join('\n');
  const images = parts.filter((p) => p.inlineData || p.inline_data).length;
  return { tokens: Math.max(1, Math.ceil(text.length / 4) + images * 258), text, image: images > 0 };
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const path = new URL(req.url, 'http://fake').pathname;
      if (path === '/__calls') return send(res, 200, calls);
      if (path === '/__reset') {
        calls = { count_tokens: 0, generate_content: 0, last_models: [], last_had_image: false };
        control = { mode: 'ok', delay_ms: 0, output_tokens: 5, tags: DEFAULT_TAGS };
        return send(res, 200, { ok: true });
      }
      if (path === '/__control') {
        control = { ...control, ...JSON.parse(raw || '{}') };
        return send(res, 200, control);
      }
      if (!req.headers['x-goog-api-key']) return send(res, 401, { error: { code: 401, message: 'missing key', status: 'UNAUTHENTICATED' } });

      const match = /^\/v1beta\/models\/([^:]+):(countTokens|generateContent)$/.exec(path);
      if (!match) return send(res, 404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
      const [, model, method] = match;
      const request = countRequest(raw);
      const promptTokens = request.tokens;

      if (method === 'countTokens') {
        calls.count_tokens += 1;
        return send(res, 200, { totalTokens: promptTokens });
      }

      calls.generate_content += 1;
      calls.last_models = [...calls.last_models.slice(-9), model];
      calls.last_had_image = request.image;
      if (control.delay_ms) await new Promise((resolve) => setTimeout(resolve, control.delay_ms));
      switch (control.mode) {
        case 'timeout':
          return; // never answers; the client times out after possibly being billed
        case 'reject_400':
          return send(res, 400, { error: { code: 400, message: 'invalid argument', status: 'INVALID_ARGUMENT' } });
        case 'quota_429':
          return send(res, 429, { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } });
        case 'server_500':
          return send(res, 500, { error: { code: 500, message: 'internal', status: 'INTERNAL' } });
        default: {
          const outputTokens = control.mode === 'overcharge' ? 1_000_000 : control.output_tokens;
          const text = control.mode === 'invalid_output'
            ? 'not json'
            : request.text.startsWith('bowr:item_tags')
            ? JSON.stringify(control.tags)
            : '{"ok":true}';
          return send(res, 200, {
            candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: promptTokens,
              candidatesTokenCount: outputTokens,
              thoughtsTokenCount: 0,
              totalTokenCount: promptTokens + outputTokens,
            },
            responseId: `fake-${calls.generate_content}`,
            modelVersion: model,
          });
        }
      }
    });
  })
  .listen(PORT, '0.0.0.0', () => console.log(`fake Gemini listening on :${PORT}`));
