# Phase 2 — Arrange, Strut and the MVP release

**Outcome:** An invited member can save a combination, confirm what they wore, correct history, and repeat it; the owner completes five real days of logging and the recognition pilot.  
**Depends on:** [Phase 1](phase-01-bower-and-gather.md).  
**Sources:** [PRD F3/F9 and model test](<../../bowr — PRD.md>); [DESIGN §§6.5–6.6, 11–14](../../DESIGN.md); [ARCHITECTURE §§6.5, 7, 10–12, 16](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-03-birdseye.md).

## Entry and scope

Build manual composition and confirmation before AI assistance. Add outfit/request/suggestion/draft/log/wear tables only as needed. Activate Outfits and Strut navigation with their usable routes. Calendar/list is MVP scope; no insights, wishlist or social UI yet.

## P2.01 — Compose, save and revisit an outfit manually

**Depends on:** Phase 1.  
**Demo:** Create dress + shoes, save, love it, edit it, and confirm none of those actions recorded a wear.

Tasks:

- [ ] **P2.01-T1** Add outfits/outfit items, revisioned `save_outfit`, `set_outfit_loved`, `delete_outfit`, source/composition identity and same-owner slot constraints. Allow named identical outfits intentionally; composition hash is not globally unique.
- [ ] **P2.01-T2** Build `/outfits`, `/outfits/new`, `/outfits/:id`, shared piece picker and composition/text list. Enforce top + bottom or one_piece, shoes and independent accessories; label incomplete combinations and allow saving them.
- [ ] **P2.01-T3** Add manual swaps, optional name, saved-state acknowledgement, unavailable archived piece handling and reversible Love. Keep picker/filter/back state and zero-AI operation.

Acceptance:

1. **P2.01-A1 — Domain/DB/E2E:** Top/bottom/shoes and dress/shoes are complete; dress does not need redundant separates. Missing shoes/clothing is labeled partial; duplicate IDs or invalid slot combinations fail.
2. **P2.01-A2 — Integration:** Foreign, deleted or newly selected archived items cannot enter a saved composition. A concurrent archive or stale revision produces a recoverable conflict.
3. **P2.01-A3 — E2E/DB:** Save, edit, Love, unlove and delete from library create zero wear rows; duplicate request returns the original save result. Multiple intentionally named identical outfits remain supported.
4. **P2.01-A4 — Device:** Composer and swaps work without drag or AI, with actual cutouts and text alternatives. Manual save meets acknowledgement target.

## P2.02 — Confirm a manual fit exactly once

**Depends on:** P2.01.  
**Demo:** Choose pieces/date, confirm, view today's log, lose the response and retry without adding a duplicate wear.

Tasks:

- [ ] **P2.02-T1** Add fit drafts/logs and wear snapshots, date/timezone/revision fields, draft uniqueness and unique fit/item relationships. Implement `save_fit_draft`, `cancel_fit_draft`, and the sole ordinary wear-creation path `confirm_fit_draft`.
- [ ] **P2.02-T2** In one transaction lock reviewed draft/items, validate at least one active owned piece, serialize same-owner/date duplicate detection, reuse unchanged selected outfit or suitable source-log combination, write fit/snapshots and record request result. Lock composition reuse/create to prevent duplicate library entries.
- [ ] **P2.02-T3** Build `/logs/new` manual path and Wear today entry from outfits/pieces. Confirm selected date and piece list; show duplicate warning with deliberate real-second-event override. Every new draft defaults keep-photo false.
- [ ] **P2.02-T4** Emit deduped `fit_logged` only after commit; reconcile unknown save outcome by request/draft identity. Failed save stays visibly unsaved with selections intact.

Acceptance:

1. **P2.02-A1 — E2E/DB:** A confirmed three-piece draft creates one fit linked to an outfit and three snapshots. A partial one-piece fit is allowed as truthful history; opening or saving a draft creates none.
2. **P2.02-A2 — Integration:** Concurrent confirmation/reconnect with same or different keys for one draft returns one fit. Lost-response recovery does not duplicate outfit, wear or analytics effects; changed body under one key conflicts.
3. **P2.02-A3 — Integration:** Two different drafts with identical pieces/date cannot both bypass duplicate warning. Explicit override creates a legitimate second event; distinct-date item count still equals one.
4. **P2.02-A4 — DB/E2E:** Zero pieces, foreign IDs, new archived selections and stale draft revisions fail atomically. Date near local midnight persists exactly through travel/timezone changes.

## P2.03 — Arrange around an owned anchor and refine results

**Depends on:** P2.01–P2.02 and P1.07.  
**Demo:** Pick a jacket, inspect suggestions, swap shoes without AI, rate/save a result and then explicitly confirm Wear today.

Tasks:

- [ ] **P2.03-T1** Add persisted outfit requests/suggestions, guarded generation endpoint and exact owner/revision/model/prompt cache identity. Filter/rank ≤60 owned candidates with include/avoid, slot, season/formality rules and a locked anchor.
- [ ] **P2.03-T2** Validate IDs, uniqueness, eligibility, constraints and computed completeness before storage and again before save/log. Normal mode requests 3–5 distinct combinations when feasible; lighter mode requests fewer; sparse closets return honestly labeled partial results.
- [ ] **P2.03-T3** Build `/outfits/arrange` entry from picker/detail, stacked inspectable results, one-line reasons, explicit Unlock, shared swaps/composer, rate/unrate with optional controlled reasons, Save and Wear today. Swaps mark old explanations as applying to the original suggestion unless explicitly recomputed.
- [ ] **P2.03-T4** Run ten-request blind styling evaluation using approved paid candidates and shared gateway; choose cheapest within the agreed quality tolerance. Persist results and prevent refresh/reopen from generating again.

Acceptance:

1. **P2.03-A1 — Integration:** Foreign/unknown/archived/duplicated/avoided IDs and missing anchors are rejected; valid sparse results retain gaps outside the owned composition. Dresses and accessories follow common slot rules.
2. **P2.03-A2 — E2E/DB:** Swap costs zero provider calls; rate/Love/Save create no wears; Wear today opens confirmation. Reopening a result restores existing output and charge count.
3. **P2.03-A3 — E2E/integration:** Zero budget and provider failure preserve anchor/constraints and open the manual composer. Archive a result item before save: show unavailable and require repair.
4. **P2.03-A4 — Human/staging:** Record blind wearability scores, selected model, invalid-output rate, actual spend and warm/cold latency. Targets are not satisfied by mocked model responses.

## P2.04 — Review and correct recognized fit pieces

**Depends on:** P2.02, P1.02 and P0.05.  
**Demo:** Upload a mirror photo, change a deliberately wrong match, remove an unwanted detection and confirm only reviewed owned pieces.

Tasks:

- [ ] **P2.04-T1** Extend fit drafts with temporary photo, bounded detections and reviewed selections; recognition job performs guarded detection, validated crop boxes, current embedding and category-compatible same-owner top-three retrieval. Optional verification is another bounded gateway task.
- [ ] **P2.04-T2** Build photo/manual equal entry choices, low-confidence-first match rows, Change/Remove and missing-match states. Similarity is assistance; do not present uncalibrated identity percentages.
- [ ] **P2.04-T3** Fence recognition by draft revision and user review; late detections may be offered but cannot replace reviewed selections or modify a confirmed draft. Allow manual picking immediately during failure/pause.
- [ ] **P2.04-T4** Capture matched/corrected/removed counts on confirmation using non-sensitive aggregate events. Record corrections as preference/matching evidence without silently retraining the embedding model.

Acceptance:

1. **P2.04-A1 — Worker/integration:** Invalid crop boxes fail safely; foreign closer neighbors never appear; incompatible/old vector spaces are excluded. Unknown/occluded cases can return no match.
2. **P2.04-A2 — E2E/DB:** Detection alone writes no wear rows. Change/Remove and date review produce exactly the confirmed set; a removed detection's wear is visibly excluded.
3. **P2.04-A3 — Integration:** Recognition completes while user confirms an earlier revision: it cannot change the logged set. Retry/cancel/expired temporary photo cannot resurrect a confirmed or canceled draft.
4. **P2.04-A4 — Device:** Deliberate mismatch is correctable without assistance; camera denied, low confidence and zero budget all reach manual confirmation. Measure actual recognition latency separately from upload.

## P2.05 — Add an unknown crop and honor photo retention

**Depends on:** P2.04 and phase-1 item lifecycle.  
**Demo:** Add an unknown bag from a fit crop, confirm the fit with Save photo off, and verify the bag image survives while full photo and unused crops disappear.

Tasks:

- [ ] **P2.05-T1** Implement Find in my Bower / Add new piece / Leave out. Explicit Add validates crop/category and creates one independent item asset with source annotation and future reshoot on the same ID.
- [ ] **P2.05-T2** Show Save this photo off on every new draft and crop-retention explanation beside Add. Confirm atomically promotes an unexpired ready photo if opted in, or queues full-photo/unused-crop deletion with null fit photo.
- [ ] **P2.05-T3** Apply 45-minute inactivity expiry, deletion target within one hour of inactivity and four-hour absolute fit-session maximum. Cancel/confirm starts immediate deletion; signer/worker checks expiry, URL lifetime clips to session; activity cannot renew indefinitely.
- [ ] **P2.05-T4** Add remove-retained-photo action independent of log deletion, pending/deleted status and cleanup retry. Include all detection payloads/temporary previews in deletion; retained new-piece crops are independent user creations even if the draft is later canceled.

Acceptance:

1. **P2.05-A1 — E2E/DB:** Explicit crop Add creates one item under repeated requests; it creates no wear until fit confirmation. Reshoot keeps the same ID and later history.
2. **P2.05-A2 — Integration/staging:** Save photo off deletes full photo and unused crops; confirmed item crop remains. Save on retains the photo; remove-photo later leaves pieces, fit and wear rows intact.
3. **P2.05-A3 — Integration:** Race session expiry/deletion with photo promotion: only a valid locked asset can be retained; otherwise preserve draft and require a new choice. Late worker cannot revive expired assets.
4. **P2.05-A4 — Staging/E2E:** Abandon/close/crash with controlled clock and real cleanup observation meets targets; storage outage truthfully shows pending. Another user's status/media access remains denied.

## P2.06 — Read, correct and repeat stable wear history

**Depends on:** P2.02–P2.05.  
**Demo:** View two fits on one date, edit one date, change its saved outfit later, and use Encore to create a new unconfirmed draft.

Tasks:

- [ ] **P2.06-T1** Build `/logs` calendar plus equivalent list and `/logs/:id`; show retained photo or composition and original worn snapshot. Add today row, per-piece last logged/distinct wear days and history-based wardrobe sorting.
- [ ] **P2.06-T2** Implement atomic `update_fit_log`/`delete_fit_log`: replace snapshot/date contributions without silently editing a reused library outfit; preserve independently owned pieces and saved outfits. Derive counts, never increment a mutable wear counter.
- [ ] **P2.06-T3** Implement Encore from historical IDs with today's local date, no old photo, keep-photo false and restore/swap prompts for unavailable pieces. Confirmation remains mandatory.
- [ ] **P2.06-T4** Extend item/outfit/account deletion across logs and suggestions: scrub item details in snapshots/generated names/reasons, preserve neutral deleted-piece references and minimal deleted-outfit shell. Disclose independently retained fit photos and offer removal.

Acceptance:

1. **P2.06-A1 — DB/E2E:** Same jacket in two same-date fits yields two events/one wear day; change a date then delete a log and recompute exact expected counts. Stored local dates do not move with timezone changes.
2. **P2.06-A2 — Integration:** Edit outfit composition/name/photo after logging: worn item identity/snapshot remains; illustration may use current authorized item photo as documented. Deleting a library outfit preserves old logs.
3. **P2.06-A3 — E2E/DB:** Encore creates only a new draft; no old photo or implicit wear. Archived pieces need restore/swap for new logs, while historical correction can retain already logged archived pieces.
4. **P2.06-A4 — Integration/staging:** Permanent piece deletion removes reusable details from all snapshots/caches/suggestions and media; old log shows neutral placeholder. A separately retained fit photo is not silently removed but is discoverable for removal.
5. **P2.06-A5 — Accessibility/device:** Calendar and list expose the same events, several fits/day and local dates; keyboard/screen-reader navigation and lost-save recovery work.

## P2.07 — Prove the MVP in real use and release it

**Depends on:** P2.01–P2.06, all phase-0/1 gates.  
**Demo:** An invited person completes Gather → Arrange → Strut → Encore, repeats the manual path with AI disabled, and the owner completes the PRD pilot.

Tasks:

- [ ] **P2.07-T1** Run five real consecutive local dates of owner logging; log obstacles and correctness issues. Run the preselected ten-piece recognition evaluation with ≥8 correct first proposed matches, reporting sample/denominator and correction rate.
- [ ] **P2.07-T2** Run DESIGN §14.2 usability tasks on real phone browsers, including Save versus Wear, mismatch repair, privacy explanation, manual paused-AI logging and Encore. Fix blocking confusion and rerun only affected tasks.
- [ ] **P2.07-T3** Run the release candidate's applicable DESIGN §14.3 and ARCHITECTURE §16 matrix: isolation, money, history, deletion, account switch, accessibility, analytics, outages, scheduler and deletion-aware restore including the new domains.
- [ ] **P2.07-T4** Record performance/quality/cost baselines and first-three-month metric definitions; add optional wardrobe-size estimate only for the digitized-share denominator. Publish support/deletion/restore runbooks and promote immutable artifacts after gates pass.

Acceptance:

1. **P2.07-A1 — Human:** Five actual logging dates and at least 8/10 predefined correct matches are evidenced. Date simulation or selected successful examples cannot substitute.
2. **P2.07-A2 — E2E/device:** Complete core journey works at normal, lighter and zero AI allowance; save/rate/love never masquerade as wear. Photo retention/deletion can be explained by participants.
3. **P2.07-A3 — Staging:** Kill worker, lose save response, fail R2/PostHog, expire auth and pause AI: each recovery matches its contract and no unauthorized or duplicate data results.
4. **P2.07-A4 — Release evidence:** All applicable MVP gates have results and remaining limitations; no unresolved ownership, billing, history corruption or privacy failure. Unsupported quality/performance claims stay unpublished.

## Phase exit and rollback

- [ ] Every P2 slice and cross-phase MVP release gate passes; five-day and recognition pilots are recorded.
- [ ] Manual use, immutable history, confirmation/idempotency, cleanup and account deletion are proven end to end.
- [ ] Metrics distinguish saved/rated/loved from worn and insufficient history from success.

This is the MVP stop point. Disable recognition/Arrange independently if necessary; keep the manual composer/logging/history available. Roll back compatible artifacts, never drop confirmed wear rows or clear snapshots. Failure of a required pilot/gate leaves MVP release incomplete; phase 3 is not a substitute.
