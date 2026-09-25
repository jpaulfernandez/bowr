# Phase 5 — Mimic, Forage and Themes

**Outcome:** A member maps a reference to owned pieces or reviews a style brief and gets wearable owned outfits, then reuses the brief without losing prior results.  
**Depends on:** [Phase 2 composition/generation](phase-02-arrange-and-strut.md), phase-1 embeddings and [phase 4](phase-04-shinies.md) for safe URLs and saving gaps.  
**Sources:** [PRD F4–F5](<../../bowr — PRD.md>); [DESIGN §§7.3–7.4, 11](../../DESIGN.md); [ARCHITECTURE §§10, 13.1–13.2](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-06-fit-profile.md).

## Entry and scope

Reuse detection, exact vector retrieval, safe URL/media processing, shared composer and budget gateway. Add `inspos`, `style_presets` and versioned briefs/references on owned request records. Finalize schemas and proposed request APIs before each slice. New web search is disabled until its complete billable envelope can be bounded and reserved.

## P5.01 — Mimic a reference with owned substitutes and visible gaps

**Depends on:** Phase-1/2 matching/composer; P4.02 safe retrieval.  
**Demo:** Upload/paste an inspiration image, select from three candidate matches per detected piece, mark a missing shoe as a gap and save the owned recreation.

Tasks:

- [ ] **P5.01-T1** Add inspiration-owned source/detection/match records and retention/deletion paths. Reuse upload or safe supported image URL fetching; clipboard/file fallback retains the request when access fails.
- [ ] **P5.01-T2** Detect bounded garment rows, compute compatible text/image embeddings and retrieve up to three eligible owned candidates per row. Return visual similarity on the documented model scale; calibrate qualitative labels rather than identity probabilities.
- [ ] **P5.01-T3** Build `/outfits/mimic`, reference/crop/candidate comparison and explicit Exact piece confirmed / Close substitute / Gap choices. Use manual picker, shared composer and partial-outfit labeling; Save gap to Shinies creates a candidate only.
- [ ] **P5.01-T4** Persist recent request/results with no regeneration on open; validate availability again on save. Confirm which user-uploaded source is retained and remove unused crops according to its lifecycle.

Acceptance:

1. **P5.01-A1 — Integration/E2E:** Known fixture exposes up to three same-owner compatible candidates and interpretable scores; no arbitrary confidence percent or cross-user nearest match appears.
2. **P5.01-A2 — E2E/DB:** Selecting substitutes creates an owned-only outfit; gap remains separate and a saved incomplete recreation is labeled partial. Saving a gap does not create an owned item or wear.
3. **P5.01-A3 — E2E:** Clipboard/URL failure reaches file/manual recovery; zero budget allows existing request inspection and manual mapping. Reopening has zero new calls.
4. **P5.01-A4 — Integration:** Deleting a reference/request cleans its own assets but preserves independently saved outfit; deleting an underlying piece scrubs materialized match details and marks it unavailable.

## P5.02 — Review a style brief from photos, keywords and references

**Depends on:** P5.01, P0.05 and P4.02.  
**Demo:** Enter “Cubao Expo fit,” inspect returned source references, remove one, edit the brief, and continue with only the approved inputs.

Tasks:

- [ ] **P5.02-T1** Extend Forage request contracts for mixed photo/keyword/occasion inputs, bounded reference list, palette/silhouette/fabric/footwear/mood brief and explicit review revision. Build `/outfits/forage` Input → Review stages; photos can produce a brief without web search.
- [ ] **P5.02-T2** Verify a current grounding adapter's maximum billable search queries/tool charges, token/thinking limits, cancellations and unknown-call handling. Reserve the whole envelope through the same gateway. If no enforceable bound exists, keep new search disabled and record the unmet full-phase gate.
- [ ] **P5.02-T3** Return 3–5 source references where available, with attribution and allowed remote thumbnails or title/link fallback. Named-person requests use public-style links, never retained copies of celebrity photos; sanitize content as untrusted data.
- [ ] **P5.02-T4** Allow remove/edit/proceed-with-fewer references, preserve approved brief and source versions, and offer photo/direct-instruction/saved-Theme paths when cheaper mode disables new search. Record source/brief lifecycle without private prompts in analytics.

Acceptance:

1. **P5.02-A1 — Integration:** Multiple billable queries from one prompt, tool errors and uncertain timeout stay inside reservation accounting. Unknown/unbounded search configuration dispatches zero calls; cheaper/paused modes never silently search.
2. **P5.02-A2 — E2E/integration:** Remove a reference/edit brief; next stage consumes exactly that reviewed revision. Late generation/extraction cannot restore a removed reference or overwritten preference.
3. **P5.02-A3 — Staging/E2E:** Keyword and photo paths yield editable briefs; missing preview rights/access uses readable linked title cards. Named-person references persist only permitted links/metadata, no permanent photo copies.
4. **P5.02-A4 — Integration:** Injected instructions in source pages cannot change ownership, tool policy or included pieces. Request deletion clears owned source assets/caches and never leaks prompt text to telemetry.

## P5.03 — Build outfits from an approved brief and conditions

**Depends on:** P5.02 and P2.03.  
**Demo:** Confirm a brief, include one owned piece, avoid another, optionally enter weather, and refine two or three actual owned outfits.

Tasks:

- [ ] **P5.03-T1** Extend guarded generation to Forage using reviewed brief/reference revision, bounded owned candidate catalog and include/avoid constraints. Reuse ID/slot/completeness checks, result persistence, save/rate and manual swaps.
- [ ] **P5.03-T2** Implement optional weather adapter for coarse city/date/conditions; choose provider at implementation, verify cost/terms/limits, cache city responses and rate-limit. Keep manual conditions and continue-without-weather, with no GPS requirement or region-specific preset.
- [ ] **P5.03-T3** Render 2–3 owned combinations normally, fewer in lighter mode, one-line reasons, visible constraints and separate missing pieces. Reject incompatible include/avoid requests explicitly; never silently relax them to complete an outfit.
- [ ] **P5.03-T4** Reuse source-independent saving and Strut confirmation. Persist model/schema/wardrobe/input revisions and clear stale explanation semantics after manual swaps.

Acceptance:

1. **P5.03-A1 — Domain/integration:** Includes/avoids, anchor if present, dresses, shoes and eligibility validate before publication/save. Impossible requests show explicit conflict/partial result instead of invented clothing.
2. **P5.03-A2 — E2E:** Weather denied/unavailable/stale allows manual conditions or none; user-provided conditions override automatic values. No precise location permission is needed.
3. **P5.03-A3 — Integration/E2E:** New request reserves once, revisit reserves zero, explicit rebuild reserves separately. Swap is free and save/rate/log retain their distinct side effects.
4. **P5.03-A4 — Staging/human:** Real candidate wardrobe yields wearable combinations using only owned items. Provider outage preserves reviewed brief and reaches manual composition.

## P5.04 — Save a Theme and restore recent work

**Depends on:** P5.02–P5.03.  
**Demo:** Save an edited brief as a Theme, reopen a recent request without a charge, and generate a new outfit from the Theme without changing the previous outfit.

Tasks:

- [ ] **P5.04-T1** Add revisioned owner-scoped style presets and save/update/delete operations, with brief/reference schema versions and minimal source links. Themes store a brief, not an outfit or appearance setting.
- [ ] **P5.04-T2** Build `/outfits/themes`, `/outfits/themes/:id`, `/outfits/requests/:id` and Recent requests for Mimic/Forage. Show existing results, stale inputs and explicit Build again/Refresh actions.
- [ ] **P5.04-T3** Define independence and cleanup: Theme edit does not mutate past requests/outfits; deleting a request removes its owned source media without deleting saved outfits; deleting a piece scrubs reusable details in briefs/results where materialized.

Acceptance:

1. **P5.04-A1 — E2E/DB:** Save/edit/reuse/delete a Theme preserves historical saved outfits; names and style brief survive reload, conflicts return the current revision.
2. **P5.04-A2 — Integration:** Reopening recent results makes zero provider calls; explicit Theme generation is one new guarded request, revalidated against current owned items.
3. **P5.04-A3 — E2E:** Cheaper mode permits saved brief/reference use without new grounding; paused mode preserves browsing/manual composition and reports generation unavailable.
4. **P5.04-A4 — Integration:** B cannot read A's source/brief/results; account/request deletion purges private inputs, derivatives and expired references without deleting independent data.

## P5.05 — Prove the two named inspiration journeys

**Depends on:** P5.01–P5.04.  
**Demo:** “Old money” and “Cubao Expo fit” each produce at least two owner-judged wearable outfits, with reference review intact and recorded processing time under fifteen seconds.

Tasks:

- [ ] **P5.05-T1** Create fixed owned wardrobe/request fixtures and owner wearability rubric; run the PRD's two named cases using real currently approved providers and budgeted calls. Include search wherever that request uses it.
- [ ] **P5.05-T2** Measure search/brief and outfit generation separately, summed machine time plus wall-clock time, with cold/warm state recorded. Exclude deliberate user review time only; do not hide search latency or reuse precomputed output for a fresh-generation claim.
- [ ] **P5.05-T3** Exercise no-search/lighter/paused, missing references, scarce wardrobe, named-person links, weather error and deletion with saved Theme/outfit dependents. Record access, accessibility, billing and UX evidence.

Acceptance:

1. **P5.05-A1 — Human/staging:** Both named cases yield two wearable owned outfits and <15 s processing as defined in the test strategy. Record sample limitations separately from p95 targets.
2. **P5.05-A2 — Integration:** New grounded-search cost is provably bounded and settled; failure of this gate leaves full keyword-search delivery incomplete even if photo/Theme paths work.
3. **P5.05-A3 — Device/E2E:** Participants understand reference versus owned substitute versus gap, can remove references and reuse a Theme, and never save an invented owned piece.

## Phase exit and rollback

- [ ] Mimic, reviewed Forage, Themes and recent requests pass their separate journeys.
- [ ] Both named latency/wearability cases and bounded-search gate pass; any limited release is explicitly labeled incomplete against the full phase.
- [ ] Optional weather, reference imagery and AI failure have working alternatives.

Disable new search first if pricing/bounds become uncertain; retain saved briefs/references and manual composition. Disable new generation independently, preserve saved outfits and results, and keep pending spend holds. Roll back request schemas compatibly; no regeneration on read.
