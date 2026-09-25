# Phase 6 — Optional fit, color and taste profiles

**Outcome:** Members can independently manage measurements, color and taste preferences; suggestions respect their choices and temporary selfies are verifiably deleted.  
**Depends on:** [Phase 5](phase-05-inspiration-and-themes.md), plus phase-3/4 integration seams.  
**Sources:** [PRD F7 and research/taste methods](<../../bowr — PRD.md>); [DESIGN §7.5](../../DESIGN.md); [ARCHITECTURE §§12, 13.2](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-07-friend-onboarding.md).

## Entry and scope

Add isolated `fit_profiles`, temporary `color_sessions`, `drape_votes` and `taste_ratings` with owner-only operations and independently deletable sections. Shared outfit use remains possible with no profile. No virtual try-on, face recognition, retained face embedding, attractiveness score or measurement inference from casual outfit photos.

## P6.01 — Enter optional measurements and receive editable guidance

**Depends on:** Phase 5; existing settings and guarded explanations.  
**Demo:** Enter height and inseam without weight, switch units, review proportion suggestions, override them, and delete only the measurement section.

Tasks:

- [ ] **P6.01-T1** Define bounded measurement/size/preference contracts, canonical units and per-field provenance. Keep body fields outside ordinary profile/settings projections, admin summaries, events and share contracts.
- [ ] **P6.01-T2** Build `/profile/fit` independent section overview and `/profile/fit/proportions`; all fields skippable, with diagrams/manual input, metric/imperial display, usual sizes by brand, comfort/fit preferences and optional emphasis choices.
- [ ] **P6.01-T3** Implement deterministic ratios only when required measurements exist; document formula inputs and uncertainty. Guarded explanations reference these outputs and user choices, with suggested rise/inseam/length/neckline language and explicit overrides.
- [ ] **P6.01-T4** Implement revisioned section reset/delete and derived-context invalidation. Do not show a completion score, weight target or body-type diagnosis.

Acceptance:

1. **P6.01-A1 — Domain/E2E:** Metric/imperial round trip preserves canonical precision; missing denominator, impossible numeric input or partial measurements cannot generate invented proportions. Optional weight can remain absent throughout.
2. **P6.01-A2 — E2E/integration:** Skip all sections and generate/log outfits normally; explicit user preference overrides inferred guidance. Paused AI preserves entered fields and deterministic facts.
3. **P6.01-A3 — DB/integration:** Other members/owner admin cannot read body data; exact values never enter analytics/public search. Section deletion clears dependent cached advice without removing wardrobe/history or other sections.
4. **P6.01-A4 — Human/accessibility:** Copy uses fit/proportion language, no flaw/slimming/weight goal; diagrams have text alternatives and numerical fields support keyboard input.

## P6.02 — Analyze coloring in a temporary, expiring session

**Depends on:** P6.01 and P0.07 deletion/liveness proof.  
**Demo:** Follow daylight/white-paper guidance, submit three shots, inspect consistency, approve numeric results and end the session with confirmed photo deletion.

Tasks:

- [ ] **P6.02-T1** Define temporary session/assets with 15-minute inactivity expiry and one-hour absolute maximum; five-minute cleanup, signer deadline clipping and persistent End session/delete action. Every original/crop/preview/drape asset is session-owned and excluded from backups/reusable caches.
- [ ] **P6.02-T2** Build `/profile/fit/color` self-report or selfie choices, PRD three-shot guidance, quality feedback and skip/retake. Reuse safe upload without creating wardrobe items; no selfie required for self-reported preferences.
- [ ] **P6.02-T3** Implement pinned landmark sampling, white-reference balance, cheek/forehead CIELAB calculation and three-shot consistency checks in Python. Derive bounded lightness/undertone/contrast suggestions, not identity; save only user-approved numerical profile/palette and explicit preferences.
- [ ] **P6.02-T4** Expose pending/deleted status and end/cancel/navigation/crash cleanup; late analysis cannot recreate an ended session. Distinguish application deletion from actual provider processing terms if an explanatory AI task is used; do not send the raw selfie to search.

Acceptance:

1. **P6.02-A1 — Worker:** Controlled fixtures verify sampling/white balance and consistency calculations; poor lighting, absent white reference, missing face or inconsistent shots return retake/skip rather than confident color results.
2. **P6.02-A2 — Integration/staging:** End, cancel, inactivity and absolute deadline deny access and delete every session derivative; real storage absence and scheduler alert are evidenced. Worker completion after expiry cannot retain a face crop.
3. **P6.02-A3 — DB/integration:** Persisted profile contains approved numerical outputs/preferences only; no raw selfie, face embedding, signed URL or biometric template survives. RLS and status capabilities reveal nothing cross-account.
4. **P6.02-A4 — E2E/device:** Self-report/skip stays useful, repeat session starts with fresh consent and expiry, and deletion outage truthfully remains pending.

## P6.03 — Rank drape colors through explicit choices

**Depends on:** P6.02.  
**Demo:** Compare the same temporary face crop against color pairs, choose Left/Right/No preference, undo a vote, inspect the ranking and end the session.

Tasks:

- [ ] **P6.03-T1** Build accessible draping with equal presentation, named colors, explicit A/B/No preference/Undo controls and optional swipe shortcut. Crop remains under the active temporary-session contract.
- [ ] **P6.03-T2** Store versioned pairwise votes and implement Bradley–Terry ranking. Planning default: persist No preference but exclude it from directional win/loss likelihood; document ties/insufficient comparisons rather than manufacture a winner. Use bounded regularization and deterministic fixtures.
- [ ] **P6.03-T3** Show near-face and anywhere palette suggestions, confidence/coverage in plain language, explicit overrides/reset and final approval. User choices supersede initial color heuristics; no mandatory season label.
- [ ] **P6.03-T4** Run owner mirror comparison using chosen held-out color pairs; record a qualitative ranking review and mismatches. This is a preference pilot, not a medical/scientific classification claim.

Acceptance:

1. **P6.03-A1 — Domain/worker:** Synthetic wins/order, sparse graph, all ties and undo give finite reproducible ranking or insufficient-data state. No preference is never counted as dislike of either color.
2. **P6.03-A2 — E2E:** Buttons and screen-reader flow perform every action without swipe; same crop/lighting is used for pair comparisons and End/delete remains visible.
3. **P6.03-A3 — Integration:** After session end, images are gone while approved palette/votes remain; deleting color section removes those votes and derived ranking. User overrides cannot be overwritten by late analysis.
4. **P6.03-A4 — Human:** Owner reports that top-ranked colors align with mirror preferences or identifies unresolved mismatches. Failure to align leaves the PRD phase-quality gate open; ranking math alone is insufficient.

## P6.04 — Teach taste without forcing completion

**Depends on:** P6.01 and versioned embedding/rating infrastructure.  
**Demo:** Rate some of 15–20 attributed outfit images, skip/resume, then see constraints/preferences reflected in a new suggestion; reset restores unpersonalized behavior.

Tasks:

- [ ] **P6.04-T1** Build `/profile/fit/taste` with Like/Not for me/Skip, optional favorite brands/icons/comfort limits/budget/lifestyle and resumable progress without required completion. Use licensed/allowed source images with attribution and safe fallback.
- [ ] **P6.04-T2** Compute a normalized taste centroid from compatible positively rated image vectors; retain explicit negative feedback for documented reranking. Empty/zero-magnitude or incompatible vectors yield unavailable taste, not arbitrary preference. Pin the algorithm/version.
- [ ] **P6.04-T3** Integrate explicit ratings/Love and confirmed wear as separately identified signals with documented bounded weights; lack of an action is never a negative vote. User-entered comfort/include/avoid and explicit drape preferences take priority over weak behavioral inference.
- [ ] **P6.04-T4** Add reset/delete/recompute after vote reversal, source deletion or embedding-version change. Record acceptance-rate/cohort denominators without exporting private taste images or text.

Acceptance:

1. **P6.04-A1 — Domain/worker:** Like/dislike/skip/reversal and no-positive-input fixtures produce documented finite outputs; Skip is not dislike and incompatible embedding versions cannot mix.
2. **P6.04-A2 — E2E:** Partial ratings save/resume; user can decline all fields and still get ordinary outfits. Explicit “no wool” cannot be overridden by a high taste score or past wear.
3. **P6.04-A3 — Integration:** Reset erases section data/derived vector/cached personalized context; subsequent generation uses no stale profile. Other accounts and admin cannot retrieve votes/vector.
4. **P6.04-A4 — Human/E2E:** Recorded fixture reranking follows explicit preferences; feedback never records new wears or silently changes a color vote. Image attribution and no-image fallback are visible.

## P6.05 — Apply optional profile context and browse fit inspiration

**Depends on:** P6.01–P6.04, P3.03, P4.03 and bounded P5 search.  
**Demo:** Enable profile context for a suggestion/verdict, opt into coarse-trait fit inspiration, edit preferences, and turn the context off again.

Tasks:

- [ ] **P6.05-T1** Extend Arrange/Forage, Birdseye and Shinies input hashes/factor schemas to include only opted-in approved profile revisions. Compute taste distance and optional palette/proportion factors; users can hide/override guidance.
- [ ] **P6.05-T2** Add opt-in fit-inspiration search using coarse declared traits and preferences, never exact measurements or selfies. Reuse bounded search, attribution and title-link fallback; show criteria and Edit preferences.
- [ ] **P6.05-T3** Add cross-feature invalidation/scrubbing when any profile section changes/deletes or all profile data resets. Explain missing/uncertain evidence instead of requiring completion or promising an exact body twin.
- [ ] **P6.05-T4** Re-run optionality, selfie deletion, override, no-AI and privacy protocols; record mirror pilot results and personalizing-versus-baseline examples without claiming broad accuracy.

Acceptance:

1. **P6.05-A1 — Integration/E2E:** No profile, partial profile, explicit override and disabled context produce valid earlier-phase behavior; stale cached advice cannot survive a profile reset unmarked.
2. **P6.05-A2 — Integration:** Intercept public-search payloads: only approved coarse traits/preferences, no selfie/exact measurements/tokens. Search off in lighter/paused/unbounded modes leaves manual/saved alternatives.
3. **P6.05-A3 — E2E/DB:** Wishlist comfort/palette factors become available only when supported; fit-profile deletion removes derived advice, not purchase/wardrobe/history records. Sharing contracts remain profile-free.
4. **P6.05-A4 — Staging/human:** Temporary image deletion passes in success/crash/outage paths and owner drape preference gate is recorded; all sections can be skipped and individually reset.

## Phase exit and rollback

- [ ] Every F7 section is optional, editable and independently deletable; explicit preferences win.
- [ ] Selfie/face-crop deletion is proven by storage checks, including abandoned sessions and late workers.
- [ ] Owner's drape ranking matches their reported mirror choices; limitations are recorded.

Disable new selfie/search sessions if privacy/cost checks fail; keep existing numerical profile editable and deletable. Stop personalization independently while preserving wardrobe functionality. Never extend an expired session or restore face media to recover a failed analysis.
