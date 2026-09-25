// Deterministic stand-in for the Gemini API (local development and tests only).
// Speaks the REST shape the official SDK uses, counts every call, and plays a
// scripted outcome so tests can prove what did or did not reach the provider.
//
//   node scripts/dev/fake-gemini.mjs            (port 8790)
//   GET  /__calls   -> { count_tokens, generate_content, last_models }
//   POST /__control -> { mode, delay_ms?, output_tokens? }
//   POST /__reset
// Modes: ok | timeout | reject_400 | quota_429 | server_500 | overcharge | invalid_output
import http from 'node:http';

const PORT = Number(process.env.FAKE_GEMINI_PORT ?? 8790);
let calls = { count_tokens: 0, generate_content: 0, last_models: [] };
let control = { mode: 'ok', delay_ms: 0, output_tokens: 5 };

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const tokens = (text) => Math.max(1, Math.ceil(text.length / 4));

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const path = new URL(req.url, 'http://fake').pathname;
      if (path === '/__calls') return send(res, 200, calls);
      if (path === '/__reset') {
        calls = { count_tokens: 0, generate_content: 0, last_models: [] };
        control = { mode: 'ok', delay_ms: 0, output_tokens: 5 };
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
      const promptTokens = tokens(raw);

      if (method === 'countTokens') {
        calls.count_tokens += 1;
        return send(res, 200, { totalTokens: promptTokens });
      }

      calls.generate_content += 1;
      calls.last_models = [...calls.last_models.slice(-9), model];
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
          const text = control.mode === 'invalid_output' ? 'not json' : '{"ok":true}';
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
