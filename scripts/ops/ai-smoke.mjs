// Operator-only: one guarded diagnostic call through the AI gateway and the shared
// budget, for provider verification (P0.05-T5). Never exposed to members.
//   SUPABASE_URL=https://<ref>.supabase.co MAINTENANCE_SECRET=... pnpm ops:ai-smoke
const url = process.env.SUPABASE_URL;
const secret = process.env.MAINTENANCE_SECRET;
if (!url || !secret) {
  console.error('SUPABASE_URL and MAINTENANCE_SECRET are required.');
  process.exit(2);
}
const response = await fetch(`${url.replace(/\/$/, '')}/functions/v1/maintenance`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ task: 'ai_diagnostic' }),
});
console.log(response.status, JSON.stringify(await response.json()));
process.exitCode = response.ok ? 0 : 1;
