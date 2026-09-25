# Phase 0 — Private, recoverable foundations

**Outcome:** A friend can enter only with a valid invite, upload privately, recover durable work, and see AI refused before dispatch at zero allowance.  
**Depends on:** No code prerequisites.  
**Sources:** [PRD: Foundations, auth, cost cap](<../../bowr — PRD.md>); [ARCHITECTURE §§3–10, 12, 14, 16–17](../../ARCHITECTURE.md); [DESIGN §§4–5, 6.1, 11–12](../../DESIGN.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-01-bower-and-gather.md).

## Entry and scope

Provision local tooling first. Staging/provider credentials are needed only at the marked integration gates. Implement foundation primitives through the following operator/member journeys. Do not create wardrobe inference, outfit/history, wishlist, profile or social tables before their delivering phases.

The original one-week estimate is high risk. P0.04 establishes the first measured processing path; re-estimate then. Phase 0 is not externally ready until its account, cleanup, budget, and recovery checks pass.

## P0.01 — Sign in locally and reach only your private shell

**Depends on:** None.  
**Demo:** Seed two members and a pending identity; each opens the app and sees only the appropriate gate and own settings.

Tasks:

- [x] **P0.01-T1** Scaffold the pnpm Expo/TypeScript workspace, shared contracts/domain/tokens, local Supabase and Python/uv worker skeleton. Pin compatible tool/runtime versions, lockfiles, model manifest format and `.env.example` names without secrets. Document setup and create test/build scripts from the shared strategy.
- [x] **P0.01-T2** Add profiles and private memberships, a minimal Auth trigger, fixed-authority owner bootstrap command, RLS/grants, hardened membership helper and revisioned/idempotent `update_profile`. Add same-owner conventions and initial AUTH fixtures.
- [x] **P0.01-T3** Implement `/`, `/auth`, `/auth/check-email`, `/auth/callback`, `/invite`, `/privacy`, `/wardrobe`, `/more`, `/settings` and safe bootstrap. Build public/pending/member/owner layouts and only available navigation; use DESIGN tokens, React Native primitives and platform adapters. Outfits/Strut become actionable in phase 2.
- [x] **P0.01-T4** Add tab-scoped auth storage, user-scoped query keys, pending/error rendering and account-change cancellation/cache disposal. Configure SPA export/deep-link rewrites, restrictive tested headers, no private service-worker cache, and web manifest.

Acceptance:

1. **P0.01-A1 — DB/E2E:** Anonymous and pending users cannot read member profiles/domain data; A cannot read/update B; member-supplied role, owner ID or admission fields are rejected. Owner bootstrap works once and cannot be invoked through the client.
2. **P0.01-A2 — E2E:** Reload `/settings`, sign in, and return to the allowed destination; forged return URLs cannot redirect outside the allowlist. A member opening `/` reaches Bower; pending reaches invite.
3. **P0.01-A3 — E2E:** Switch A→B during an in-flight A request. No A text, image, draft or late response appears under B. Closing the tab has the documented session behavior.
4. **P0.01-A4 — E2E/device:** Shell works with keyboard/screen reader, at 320 px and 200% text, on a phone browser; web export and source-map/secret inspection pass.

## P0.02 — Owner invites a friend who redeems once

**Depends on:** P0.01.  
**Demo:** Owner creates an invite in `/admin`; a real invited email signs in, redeems, and reaches the privacy/first-step onboarding screen.

Tasks:

- [x] **P0.02-T1** Add private invite digests, redemptions, atomic throttles and audit records. Generate ≥128-bit random single-use codes, default seven-day expiry; return plaintext once. Lock membership/invite rows on redemption, enforce five attempts/hour/account plus IP throttle, and return a generic unavailable-code error.
- [x] **P0.02-T2** Build owner invite create/copy/revoke/status and safe member summary; pending gate supports paste, retry time, sign out and account deletion. No automatic message delivery; no private note/code in analytics or logs.
- [ ] **P0.02-T3** Configure staging Google OAuth/PKCE, exact callbacks and verified custom SMTP. Implement expired-link/resend/change-email and cross-browser recovery. Add onboarding privacy text, skip/explore, and availability-aware next actions.
- [x] **P0.02-T4** Implement hourly pending-account cleanup after 24 hours with lock/recheck/deleting transition; failed Auth deletion stays retryable. Establish private API error mapping and idempotency envelopes for these commands.

Acceptance:

1. **P0.02-A1 — Integration:** Race two accounts for one code: exactly one admission and one use. Retry the winner's request: same membership, no extra use. Expired/revoked/exhausted codes fail without disclosing private notes.
2. **P0.02-A2 — DB/integration:** The first five attempts obey the configured limit; the sixth is throttled with retry time. Parallel attempts cannot bypass the counter. Race cleanup with redemption: an admitted account is never removed.
3. **P0.02-A3 — Staging/device:** A non-project-team invited address receives a magic link; Google and email flows both complete on the deployed host. Expired/cross-browser links give a usable recovery route.
4. **P0.02-A4 — DB/E2E:** Nonowners cannot use admin endpoints; unused-code revocation does not suspend an existing member. Onboarding can be skipped without measurements, photos or notification permission.

## P0.03 — Upload and retrieve a private validated photo

**Depends on:** P0.01–P0.02.  
**Demo:** From a minimal Gather upload receipt, A uploads a fixture and views its sanitized original; B cannot request or retrieve new authorized access to it.

Tasks:

- [x] **P0.03-T1** Add upload batches/entries, media metadata, private object manifest, mutation identities and asset lifecycle. Create signed PUT/renew/complete and media-access APIs; clients supply descriptors/asset IDs, never object keys. Use stable file identities and typed attachments.
- [ ] **P0.03-T2** Configure private staging R2 bucket and exact-origin CORS. Use 10-minute PUT and 5-minute GET defaults, clipped to temporary expiry; `no-store` responses and memory-only images. Separate writable quarantine keys from server-controlled validated objects.
- [x] **P0.03-T3** Implement worker decode/normalization contract: 20 MiB and 40 MP bounds, orientation/rotation, sRGB, EXIF/GPS removal, sanitized 1024 px original and 2048 px care-label exception. Pin and prove HEIC decoder before advertising it; reject animations/unsupported/corrupt bytes. Introduce the minimal persisted validation-job identity and authenticated scoped dispatch/callback needed for this path now; P0.04 completes its lease/recovery behavior. Do not create a disposable synchronous or unauthenticated worker path.
- [x] **P0.03-T4** Build receipt/status, per-file validation failure, camera-denied/file-picker alternative and expired-image refresh-once behavior. Introduce temporary deletion tasks; cancel rejects access and rechecks raw keys after PUT expiry.

Acceptance:

1. **P0.03-A1 — Worker/staging:** Valid JPEG/PNG/WebP/HEIC outputs have expected orientation/dimensions and no metadata. Spoofed MIME, corrupt data, oversized/over-pixel and unsupported multi-frame inputs are rejected without publishing a trusted asset.
2. **P0.03-A2 — Integration:** Replay a still-valid PUT after normalization: canonical viewed bytes do not change. Cancel then replay: reconciliation removes the recreated quarantine object after URL expiry.
3. **P0.03-A3 — DB/integration:** B, pending and suspended identities cannot sign A's asset, guess a different variant, attach it to their own row, or select private object keys. Expired signed access is refreshed only after fresh authorization.
4. **P0.03-A4 — E2E:** Lost completion response and repeat same request return the same entry; changed input under the same key conflicts. Upload HTTP success does not show validated/retained success prematurely.

## P0.04 — Leave an upload and recover processing after failure

**Depends on:** P0.03.  
**Demo:** Close the tab after upload, kill its validation worker, and reopen the receipt; the original job recovers and publishes once.

Tasks:

- [x] **P0.04-T1** Complete the private jobs/payloads introduced by P0.03 with dependency and dedupe identity, queued/running/retry/blocked/review/terminal states. Commit validation jobs with upload completion; connect existing receipt to durable status.
- [x] **P0.04-T2** Implement authenticated Modal wake-up, single-use claim nonce, job/stage-scoped execution capabilities, claim locks, lease generation and fenced callbacks. Worker gets no general database, Gemini or R2 master key.
- [x] **P0.04-T3** Add heartbeat, bounded concurrency/deadlines, maximum three deterministic attempts, immutable output/checksum handling and canceled-target cleanup. Start from architecture limits, then measure before tuning.
- [x] **P0.04-T4** Schedule minute dispatch/reconciliation using protected maintenance credentials; recover missed dispatch and expired leases. Poll 2/5/10 seconds while visible, stop at terminal state, refetch on focus. Expose safe failure codes and manual retry/cancel.

Acceptance:

1. **P0.04-A1 — Integration:** Drop the initial dispatch: scheduled reconciliation still completes the existing job. Kill a worker midstage: a new lease completes; its predecessor cannot overwrite the result.
2. **P0.04-A2 — Integration:** Duplicate wake-up/callback yields one published asset/result. Wrong job, stage, asset, expired capability and ordinary user JWT are rejected on internal APIs.
3. **P0.04-A3 — Integration:** Cancel/delete while processing, then complete the old worker: no revival; unreferenced output is queued for deletion. Retry budget is finite and safe state survives storage failure.
4. **P0.04-A4 — E2E/staging:** Uploaded work survives tab closure and reload; unuploaded files are identified for reselection. Receipt never creates another job merely by reopening.

## P0.05 — Owner sees and controls bounded AI work

**Depends on:** P0.04.  
**Demo:** An owner runs a guarded synthetic diagnostic, sees actual/reserved usage, sets allowance to zero, and confirms the next diagnostic never reaches the provider.

Tasks:

- [ ] **P0.05-T1** Add budget periods, per-attempt `ai_usage`, cross-period holds and atomic reservation/dispatch/settlement functions in integer USD micros. Enforce lighter/stop/ceiling ordering and defaults $8/$9.50/$10, with UTC month reset.
- [ ] **P0.05-T2** Implement the internal-only AI gateway: server task aliases, counted inputs, bounded billed output/thinking, effective-dated prices, schema validation, unique attempts, and no direct worker/client provider access. Unknown price/bound/accounting state fails closed.
- [ ] **P0.05-T3** Implement uncertain dispatch holds, separately reserved explicit retry/repair, cancellation settlement, chronological period locks, rollover holds and tariff recheck before dispatch. An actual charge above reservation pauses AI and alerts.
- [ ] **P0.05-T4** Build admin spend actual/reserved/unknown/task/member summaries and deliberate revisioned threshold changes. Bootstrap/member status supplies mode and local reset time without others' usage; normal/lighter/paused/provider-error states are distinct.
- [ ] **P0.05-T5** Verify real paid Gemini project, current approved model IDs/prices, output bounds, billing period and available cap/prepaid settings; record configuration, disable automatic top-up where supported. Add budget-mode analytics using only allowed fields. The test runner stays operator-only.

Acceptance:

1. **P0.05-A1 — Integration:** At zero stop, test requests record a refusal and provider call count remains zero; validation/cutout-independent work still completes. Nonowner cannot change thresholds; no configuration can raise ceiling above $10.
2. **P0.05-A2 — Integration:** Parallel requests at $8 and $9.50 boundaries cannot oversubscribe; a request crossing $8 is repriced under lighter mode. Assert settled + reservations + applicable holds never exceed admitted allowance.
3. **P0.05-A3 — Integration:** Timeout after possible dispatch keeps the reservation; reload/lease expiry cannot free it or automatically charge again. Duplicate settlement is a no-op; known unbilled rejection releases once.
4. **P0.05-A4 — Integration:** Controlled tariff change and UTC rollover recheck prices, prevent double-counted financial totals, preserve uncertain cross-period holds, and block calls too close to rollover. Missing bounds and over-reservation charges fail closed.
5. **P0.05-A5 — Staging/E2E:** One explicitly budgeted synthetic paid smoke reconciles observed usage; admin displays current mode/reset correctly in Manila and another timezone. Failure of provider verification withholds AI enablement.

## P0.06 — Manage account access and delete your own data

**Depends on:** P0.02–P0.05.  
**Demo:** A member updates settings and deletes a fixture account after fresh authentication; an owner with another member must transfer ownership first.

Tasks:

- [ ] **P0.06-T1** Complete settings for display name, optional city, locale/timezone, units, sign out, privacy and account deletion. Add owner suspension with explicit consequences and no wardrobe/photo/profile access through administration.
- [ ] **P0.06-T2** Implement action-bound ten-minute fresh-auth challenges, single-use proofs, transactional ownership transfer and last-owner deletion rules. A refreshed access token alone cannot prove fresh authentication.
- [ ] **P0.06-T3** Build recoverable account deletion: mark deleting, block signing/reads/jobs, revoke sessions, capture asset manifest, delete domain/Auth data, detach safe accounting identity, preserve other members and nullable invite relationships. Provide restricted expiring deletion-status capability.
- [ ] **P0.06-T4** Add lifecycle extension hooks for later domain cleanup, cache/object-URL disposal and analytics identity deletion/reset. UI distinguishes pending deletion from verified object absence.

Acceptance:

1. **P0.06-A1 — DB/E2E:** Client cannot change authority through profile edits; owner can see only specified aggregates. Suspension blocks new table/API/media access immediately without claiming old signed bytes can be recalled.
2. **P0.06-A2 — Integration:** Old/replayed/wrong-action/wrong-user reauth proof fails. Ownership transfer is atomic and leaves exactly one active owner; concurrent transfers cannot create two owners.
3. **P0.06-A3 — Integration/E2E:** Sole owner with active friends cannot self-delete before transfer. Last owner without active friends can delete, leaving operator bootstrap required. Friends' accounts survive.
4. **P0.06-A4 — Integration:** Fail object/Auth deletion halfway: access stays denied, status remains pending, retry completes without losing manifest; late jobs cannot recreate data. Status capability reveals no private content.

## P0.07 — Operate and restore the private foundation

**Depends on:** P0.03–P0.06.  
**Demo:** An operator detects a stopped cleanup scheduler, recovers it, then restores an isolated backup without reviving deleted data or old paid jobs.

Tasks:

- [ ] **P0.07-T1** Create CI for contracts/types, RLS/integration/worker checks, web export and immutable worker build; staging promotion order is additive migration → compatible worker/internal → public API → web. Document artifact rollback and environment/secret inventory.
- [ ] **P0.07-T2** Implement five-minute temporary cleanup, daily orphan reconciliation and expiry checks at sign/read/callback. Measure one-hour abandoned-upload cleanup and 24-hour retained-asset deletion targets; install an independent missed-heartbeat/stuck-work alert and manual recovery command.
- [ ] **P0.07-T3** Configure encrypted daily DB exports, seven-day retention and an external minimal deletion journal. Rehearse isolated Auth/schema restore, deletion replay, expired-session purge, stale job/AI disablement and media existence reconciliation. Document 24-hour RPO/one-day restoration targets and absence of independent retained-media backup.
- [ ] **P0.07-T4** Wire allowlisted PostHog events with recording/autocapture/automatic URL capture off; scrub errors and route templates. Add redacted operational health/spend/deletion summaries and infrastructure resource alerts without a new monitoring platform.

Acceptance:

1. **P0.07-A1 — Integration/staging:** Missed maintenance heartbeat is detected independently of the failed scheduler. Recovery drains queued deletions; outage status does not falsely say deleted.
2. **P0.07-A2 — Staging:** Restore fixture DB into isolation; journal prevents deleted details from becoming visible, old jobs cannot dispatch, and session access is reestablished safely. Record elapsed restoration and export age against targets.
3. **P0.07-A3 — E2E/integration:** Inspect emitted analytics and redacted errors for forbidden fields; PostHog outage does not interrupt uploads/settings. Logout resets identity and cache.
4. **P0.07-A4 — Staging:** Deep links and both auth callbacks work after deployment; roll back client/Edge/worker artifact with additive schema retained. No secrets appear in public bundle or logs.

## Phase exit and rollback

- [ ] Real friend admission/private-upload/zero-AI demo passes; all P0 acceptance evidence exists.
- [ ] Ownership, invite/cleanup races, worker recovery, budget concurrency and account deletion pass against actual transactions.
- [ ] Real SMTP/R2/Modal configuration, format support and paid-model gates are recorded; unresolved provider gates are explicitly disabled.
- [ ] Cleanup and deletion-aware restore are demonstrated; published privacy text matches observed behavior.

Disable AI/processing admission independently during incidents; keep membership and safe reads intact where services permit. Roll back immutable compatible artifacts, retain ledger/deletion manifests, and drain cleanup. Never clear uncertain spend or destructively roll back production schema to recover availability.
