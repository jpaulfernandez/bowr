# Phases 0 and 1 — completion audit and plan

**Audited:** 27 September 2026, against `main` at `2c6afbf` plus the working tree.  
**Inputs:** [phase 0](phase-00-foundations.md), [phase 1](phase-01-bower-and-gather.md), the 14 files in [evidence/](evidence/), [test strategy](test-strategy.md), the runbooks, and the repository.  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md).

This file adds no slice IDs. Every work item below closes an existing task (`-T`) or acceptance case (`-A`). Check the box in the phase file only when its evidence file records the result.

## How this was verified

- Read every evidence file's acceptance table and "Remaining failures" section, and compared them with the phase checkboxes.
- Confirmed the named migrations, pgTAP, integration, pytest and Playwright files exist for every slice P0.01–P1.07.
- Confirmed GitHub CI run `36290823421` on `2c6afbf` passed all three jobs (checks, local-stack suites, artifacts).
- **Not done:** the suites were not rerun locally in this audit, and nothing on staging, a device or a paid provider was exercised. The uncommitted P2.01 files in the working tree were not audited.

## Summary

| | Phase 0 | Phase 1 |
| --- | --- | --- |
| Tasks checked | 23 of 29 (after D2) | 22 of 26 |
| Unchecked tasks | P0.02-T3, P0.03-T2, P0.05-T5, P0.07-T2, P0.07-T3, P0.07-T4 | P1.02-T1, P1.07-T1, P1.07-T2, P1.07-T3 |
| Acceptance cases fully passed | 20 of 29 | 18 of 28 |
| Acceptance cases open or partly open | 9 | 10 |
| Exit items checked | 2 of 4 | 0 of 3 |

No missing local code path was found for a checked task, with one exception: **FashionCLIP is not implemented** (`services/worker/src/bowr_worker/embedding.py` contains only the development space). Everything else that is open needs staging, a provider account, a physical device, the owner's photos, or a recorded decision.

## Open acceptance cases

| Case | Open part | Blocked on | Workstream |
| --- | --- | --- | --- |
| P0.01-A4 | Real phone browser, screen reader, OS text size | Device | G |
| P0.02-A3 | Magic link to a non-team address; expired and cross-browser recovery on the deployed host | Staging, SMTP delivery | B |
| P0.03-A1 | Formats through deployed Modal and R2; HEIC on Modal | R2, Modal | C |
| P0.04-A4 | Tab-close recovery with real dispatch and cold starts | Modal | C |
| P0.05-A5 | Paid smoke reconciled with provider usage; mode and reset in two timezones | Paid Gemini | E |
| P0.06 (withheld in its evidence, no case named) | Fresh-authentication email through real SMTP | Staging, SMTP | B |
| P0.07-A1 | External heartbeat detects a stopped scheduler | Staging | D |
| P0.07-A2 | Restore of a staging export; sign-in re-established | Staging | D |
| P0.07-A4 | Deployed deep links and callback; artifact rollback | Staging | A, D |
| P1.01-A4 | Phone, screen reader, camera capture | Device | G |
| P1.02-A2 | Vectors and retrieval in the production space | FashionCLIP | F |
| P1.03-A4 | Device pass, including camera denied on web (D3) | Device | G |
| P1.05-A4 | Mask editor on a real touch device | Device | G |
| P1.06-A3 | Deletion and storage outage proven on staging | R2 | D |
| P1.06-A4 | 300 pieces with real images on a phone; find-a-piece usability task | Device, human | G |
| P1.07-A1 | Fifty owner-accepted pieces | Owner, staging | H |
| P1.07-A2 | Paid blind comparison on 20 labeled photos | Paid Gemini, owner photos | E |
| P1.07-A3 | Production embeddings; real-photo and Modal benchmarks | FashionCLIP, Modal | F, H |
| P1.07-A4 | Device part of the zero-allowance journey | Device | G |

## Documentation defects found

These need no external access. Fix them first (workstream 0).

1. **Fixed 27 September 2026 (D1):** P0.02-T3, P0.02-A3 and P0.07-A4 required Google sign-in. They are now email-only, with Google deferred.
2. **P0.07-T2, T3 and T4 are checked but parts are withheld:** the installed external heartbeat monitor, scheduled daily exports, provider resource alerts and PostHog project settings. P0.02-T3 and P0.03-T2 were left unchecked for the same kind of gap, so the rule is applied inconsistently.
3. **P0.07 evidence is stale:** it says CI has not run on GitHub. It has, and passed. The heartbeat workflow runs but is skipped (`HEALTH_CHECK_ENABLED` is off).
4. **P0.05-T5 mixes delivered and open work.** Budget-mode analytics shipped under P0.07-T4; only provider verification is open.
5. **Phase 1 has no dated exit status.** Phase 0 has one.
6. **Stale status lines:** README "Baseline" and "Repository work map" say nothing exists; test-strategy says no tests exist.
7. **Evidence names branches, not commits.** The branches are merged; record the commit SHAs.
8. **All 14 evidence files say "Human review pending."** No reviewer is recorded.
9. **Two recorded issues have no owning task:**
   - P1.06: the per-member running limit is checked when a claim is issued, not when it is used.
   - P1.07: a fresh-authentication link opened in the same second as the request reads as expired.

## Decisions needed from the owner

| ID | Question | Recommendation |
| --- | --- | --- |
| D1 | How do the Google acceptance checks close? | **Decided 27 September 2026:** email only. Google is deferred and must pass its own checks before `EXPO_PUBLIC_AUTH_GOOGLE_ENABLED=true` |
| D2 | Should P0.07-T2/T3/T4 be unchecked until their staging parts pass? | **Decided 27 September 2026:** yes, unchecked until the staging parts pass |
| D3 | Does "camera denied" (P1.03-A4, P1.01-T3 "take photo") apply to the web build? | **Decided 27 September 2026:** yes. Proven on a real phone in workstream G |
| D4 | May phase 2 start before phase 1 exits? P2.01 files already exist in the working tree. | Allow P2.01–P2.02 (manual, no AI or vectors). Hold P2.03 (depends on P1.07) and P2.04 (needs FashionCLIP) |
| D5 | Which budget pays for the smoke and the extraction comparison? | **Decided 27 September 2026:** the US$10 ceiling is the production rule. Testing uses a separate cap on staging: US$2 for now |
| D6 | Who reviews the evidence? | Owner signs each file after workstream G |

## Workstreams

Order: 0 → A → (B, C in parallel) → D → E → F → G → H → exit. F can start as soon as an environment can reach Hugging Face.

### 0 — Correct the documents

- [x] Apply D1 and D3 to the phase files with dates.
- [x] Apply D2 (decided 27 September 2026: unchecked until staging passes).
- [x] Fix defects 3–7. Add a dated exit status to phase 1.
- [x] Assign the two orphaned issues (defect 9) to a slice, or record them as accepted limitations. Recorded as accepted limitations in the phase 1 exit status (owner decision, 27 September 2026).

Verify: every unchecked box maps to a row in "Open acceptance cases"; no evidence file contradicts the repository.

### A — Stand up staging

Closes part of P0.07-A4. Steps are in [deploy.md](../runbooks/deploy.md) and [environments.md](../runbooks/environments.md).

- [x] `supabase db push` to project `bowr`; enable pgvector, `pg_cron` and `pg_net`; set Edge secrets and both Vault secrets. Done 27 September 2026 from `2c6afbf`.
- [ ] Run the staging RLS and grant checklist with pending, suspended and member identities. Anonymous access is proven blocked (27 September 2026); the three identities need accounts on staging.
- [x] Deploy `internal`, `maintenance`, then `api`.
- [x] Build and deploy the web app to Vercel. Set `APP_ORIGINS`, the Site URL and the redirect allowlist from the real hostname. Done 27 September 2026: `https://bowr-staging.vercel.app`.
- [x] Bootstrap the owner with `pnpm ops:bootstrap-owner`. Done 27 September 2026 through the Supabase CLI; the owner has not yet completed a sign-in in the browser.

Verify: `/settings` reloads on the deployed host; Edge responses carry exact-origin CORS (the P0.01 local limitation); the bundle inspection passes on the staging build; the function inventory is no longer empty.

### B — Email admission (P0.02-T3, P0.02-A3, P0.06 email gate)

- [ ] Confirm the Resend key may send from `janpaulfernandez.com` (SPF and DKIM verified). SMTP authentication alone does not prove this. An email was delivered on 27 September 2026, but Gmail filed it as spam; SPF, DKIM and DMARC alignment still need checking.
- [ ] Invite a non-team address. It receives the link, signs in, redeems and reaches onboarding.
- [ ] Exercise expired-link, resend, change-email and other-browser recovery on the deployed host.
- [ ] Complete a fresh-authentication challenge (account deletion on a fixture account) through real email.
- [ ] Confirm hosted Supabase supplies `cf-connecting-ip` for the IP throttle.

Verify: results recorded in `evidence/P0.02.md` and `evidence/P0.06.md`, with no address or code in the record.

### C — Private storage and worker (P0.03-T2, P0.03-A1, P0.04-A4)

- [x] Create the private R2 bucket and scoped token; apply exact-origin CORS with `scripts/dev/setup-storage.mjs`. Done 27 September 2026; CORS applied with `wrangler`, because the scoped token has object permissions only.
- [x] Deploy `modal_app.py`; create the proxy-auth token; set `WORKER_DISPATCH_*`. Done 27 September 2026.
- [ ] Upload every MEDIA fixture through the deployed path and compare with `p0_03_uploads.test.ts`.
- [ ] Set `UPLOAD_HEIC_ENABLED=true` only if the HEIC fixture passes on Modal. Otherwise record it as disabled.
- [ ] Close the tab after upload and reopen the receipt; record cold and warm cutout times against the ≤60 s and ≤15 s targets.
- [x] Record the R2 location hint and Modal region. APAC; Modal region not pinned.

Verify: B, pending and suspended identities still cannot sign A's asset on staging; no second job is created by reopening.

### D — Operations on staging (P0.07-A1, A2, A4; P1.06-A3)

- [ ] Set `HEALTH_URL`, `HEALTH_CHECK_TOKEN` and `HEALTH_CHECK_ENABLED`. Pause the schedules and confirm the GitHub heartbeat fails, then recover with `pnpm ops:recover-maintenance`.
- [ ] Create the journal bucket with its 30-day rule. Schedule daily encrypted exports to a location outside Supabase. Journal bucket and rule done; scheduled exports still open.
- [ ] Restore a staging export into an isolated hosted project, replay the journal, and confirm sign-in is re-established. Record export age and elapsed time.
- [ ] Roll back the web, Edge and worker artifacts once with the schema retained.
- [ ] Set PostHog project settings and provider resource alerts.
- [ ] Permanently delete a fixture piece on staging and prove object absence; repeat with storage unavailable and confirm the status stays pending.

Verify: health output and logs contain no secrets, emails or object keys.

### E — Paid model gates (P0.05-T5, P0.05-A5, P1.07-T1, P1.07-A2, part of P1.07-T2)

Testing spend is separate from production's US$10 (D5). AI stays disabled until the first four items pass.

- [ ] Set staging's stop and ceiling, and the staging Google project cap, to the US$2 test cap (D5).

- [ ] Verify the dedicated paid project, the model ID, prices and output bounds in `config/models.yaml` against Google's current list. Add a new effective-dated price row if they differ.
- [ ] Disable automatic top-up where supported. Production's Google project cap is US$10.
- [ ] Run `pnpm ops:ai-smoke` once and reconcile provider usage with `private.ai_usage`. Check the admin mode and reset time in Manila and one other timezone.
- [ ] Prepare 20 owner-labeled photos, stored privately, covering shoes, dresses and difficult accessories. Commit only a redacted manifest.
- [ ] Add an alias per approved candidate and run `pnpm eval:extraction`.
- [ ] Pin the cheapest candidate within about 10% of the best, or record that none passes and keep the gate open.

Verify: the report has denominators, invalid rate, latency and guarded cost; unedited acceptance is compared with the 80% target and stated as a pilot signal.

### F — FashionCLIP (P1.02-T1, P1.02-A2, part of P1.07-T2 and P1.07-A3)

The only open item that needs new product code. It also gates the phase-1 exit item "matching infrastructure is usable before phase 2".

- [x] From an environment that can reach Hugging Face, verify the license and pin the weights with a revision and SHA-256 in `config/models.yaml`. MIT; ONNX export at `7e3ba62`.
- [x] Implement the space in `embedding.py` with its preprocessing version, and add its weights to `pnpm worker:models` and the Modal image. Local only: not committed, and the deployed worker does not include it yet.
- [ ] Measure memory, CPU and cold start on Modal; resize the function if 2 GiB is not enough with the cutout model loaded. Local peak was 1,749 MiB, so the function is set to 3,072 MiB; Modal measurement still open.
- [ ] Set `private.embedding_space` on staging and backfill existing pieces. Do not mix spaces.

Verify: the P1.02-A2 cases pass in the production space (finite, normalized, 512 values; owner-filtered retrieval ignores B's closer match); an unknown or failed license keeps it disabled.

### G — Device and human pass (P0.01-A4, P1.01-A4, P1.03-A4, P1.05-A4, P1.06-A4, P1.07-A4)

Run once on the staging build, after C.

- [ ] Record device, OS and browser. Use at least one iPhone with VoiceOver; add Android with TalkBack if available.
- [ ] Shell, Gather, the 20-row queue, piece detail and Bower with a screen reader, at 320 px and at 200% text.
- [ ] Phone camera formats through the file chooser, including HEIC if enabled.
- [ ] Camera denied on web (D3): deny camera access to the browser, tap **Take photo**, and confirm the member can still add photos through **Choose photos** with a truthful next action. If the tap dead-ends, add an in-app fallback and rerun.
- [ ] Mask editor by touch and zoom, and the non-drawing alternatives.
- [ ] 300-piece Bower with real thumbnails: first page and search, at least 30 samples, median and p95 against 3 s and 1.5 s.
- [ ] Find-a-piece usability task and filter reset.
- [ ] Zero-allowance journey on the phone.

Verify: every failure is recorded with steps; blocking failures get a fix and a rerun.

### H — Fifty-piece pilot (P1.07-T3, P1.07-A1, P1.07-A3)

Needs C, E and F.

- [ ] The owner catalogs fifty real pieces on staging, including shoes, dresses and difficult accessories.
- [ ] Record every unresolved cutout or tag problem.
- [ ] Run `pnpm worker:benchmark --images <dir>` on owner-approved photos; record real storage and compute.
- [ ] Confirm each pilot piece has a current embedding.
- [ ] Exercise grouped accessories, a care label, a duplicate decision and a photo repair with real photos.

Verify: fifty distinct pieces with owner-accepted cutouts and metadata; no photo, file name or signed URL in the evidence.

## Phase exit

- [ ] Phase 0: all 29 acceptance cases have evidence or a recorded amendment (D1); the real friend admission, private upload and zero-AI demo is recorded; every unresolved provider gate is explicitly disabled.
- [ ] Phase 1: workstreams E–H recorded; the three exit items checked; limitations stated.
- [ ] Evidence reviewed and signed (D6).
- [ ] README and AGENTS.md status lines updated.
