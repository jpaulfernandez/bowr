/** Control and observe the local fake Gemini (scripts/dev/fake-gemini.mjs). */
const BASE = process.env.FAKE_GEMINI_URL ?? 'http://127.0.0.1:8790';

export type FakeMode = 'ok' | 'timeout' | 'reject_400' | 'quota_429' | 'server_500' | 'overcharge' | 'invalid_output';

export const fakeGemini = {
  async reset() {
    await fetch(`${BASE}/__reset`, { method: 'POST' });
  },
  async mode(mode: FakeMode) {
    await fetch(`${BASE}/__control`, { method: 'POST', body: JSON.stringify({ mode }) });
  },
  async calls(): Promise<{ count_tokens: number; generate_content: number; last_models: string[] }> {
    return (await fetch(`${BASE}/__calls`)).json();
  },
};
