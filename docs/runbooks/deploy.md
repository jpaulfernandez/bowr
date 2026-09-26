# Deployment, promotion and rollback

Status: CI is implemented (`.github/workflows/ci.yml`). Staging and production are not provisioned yet, so the promotion steps below have not been exercised. That is gate P0.07-A4.

## What CI proves on every change

| Job | Contents |
| --- | --- |
| `checks` | ESLint, `deno lint`/`fmt`, ruff, TypeScript (app, packages, Edge), Vitest (contracts, domain, generated worker-contract drift), Deno tests, pytest |
| `stack` | Local Supabase (migrations from scratch), R2 stand-in, local worker, fake Gemini. Runs pgTAP (RLS and grants with pending, suspended and deleting identities), integration (races, recovery, deletion, restore rehearsal), the web export with bundle inspection, and Playwright with axe. |
| `artifacts` | The worker wheel built from the frozen `uv.lock`, with SHA-256 sums, kept as `worker-<commit>`. Modal builds its image from the same lockfile and source. |

No billable provider is called in CI.

## Promotion order (staging, then production)

Promote one commit that passed CI. Every schema change is additive, so the previous application artifacts keep working during each step.

1. **Database:** `supabase link --project-ref <ref>`, then `supabase db push`. Before deploying code, check RLS and grants with the pending, suspended and member identities in staging (`pnpm test:db` targets local only; run the staging checklist in the P0 evidence).
2. **Worker and internal API:**
   - `cd services/worker && uv run --extra modal modal deploy modal_app.py`, from the same commit.
   - `supabase functions deploy internal --project-ref <ref>`
   - `supabase functions deploy maintenance --project-ref <ref>`
3. **Public API:** `supabase functions deploy api --project-ref <ref>`.
4. **Web:** build with the environment's `EXPO_PUBLIC_*` values using `pnpm build:web`. This fails if the bundle contains a secret or a source map. Deploy `apps/app/.vercel/output` with `vercel deploy --prebuilt` (add `--prod` for production).
5. **Smoke checks:**
   - A deep link such as `/settings` reloads.
   - Google and email-link sign-in both complete on the deployed host.
   - The health check returns 200.
   - An upload reaches Ready.
   - `pnpm ops:ai-smoke` runs only after P0.05-T5.

Keep feature flags off for incomplete phases.

## Rollback

- **Web:** `vercel rollback` to the previous deployment, or promote the previous prebuilt output.
- **Edge Functions:** check out the previous commit, then run `supabase functions deploy <name>`.
- **Worker:** redeploy `modal_app.py` from the previous commit. Modal also keeps previous app versions.
- **Database:** never run a destructive down-migration against production data. Keep the additive schema and roll back only the artifacts. Fix forward, or use the rehearsed restore ([backup-restore.md](backup-restore.md)) for a destructive failure.
- During an incident:
  - Set the pause to $0 (Admin → AI spend) or `AI_ENABLED=false` to stop paid work.
  - Keep cleanup running (`pnpm ops:recover-maintenance`).
  - Never clear uncertain spend.

## Environment and secret inventory

See [environments.md](environments.md). Each environment has its own Supabase project, R2 buckets (private media and deletion journal), Modal environment, Gemini project, PostHog project, Auth callbacks and secrets. CI holds no deployment secrets. Add deployment tokens only to protected GitHub environments when staging exists.
