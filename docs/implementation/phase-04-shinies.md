# Phase 4 — Shinies: evaluate and record a purchase

**Outcome:** A Uniqlo link and Shein screenshot can become reviewed wishlist candidates with evidence-based verdicts; buying creates exactly one owned piece.  
**Depends on:** [Phase 2](phase-02-arrange-and-strut.md) and [phase-3 measures/combinations](phase-03-birdseye.md).  
**Sources:** [PRD F8](<../../bowr — PRD.md>); [DESIGN §7.2](../../DESIGN.md); [ARCHITECTURE §§13.1, 12](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-05-inspiration-and-themes.md).

## Entry and scope

Add `wishlist_items` with source/variant/title/price/currency, owned asset references, lifecycle, factor evidence, verdict revision and resulting item mapping. Below endpoint/RPC names for this new domain are proposed contracts to finalize before implementation, following the existing versioned/idempotent pattern. No checkout, affiliate program or broad store scraper.

## P4.01 — Save and manage a candidate manually or by screenshot

**Depends on:** Phase 2, phase-1 media/tag pipeline.  
**Demo:** Add a Shein screenshot, correct variant/price, and find it under Wanted; manual entry still works at zero allowance.

Tasks:

- [ ] **P4.01-T1** Add RLS-protected wishlist records and `save_wishlist_item`/status/delete mutations with provenance/revisions. Keep wishlist items entirely outside owned search, outfit eligibility and wardrobe counts.
- [ ] **P4.01-T2** Build `/wishlist`, `/wishlist/new`, `/wishlist/:id`, Wanted/Bought/Dropped filters and More entry. Accept screenshot/photo or manual title; reuse media validation and guarded extraction with editable title/image/price/currency/variant review.
- [ ] **P4.01-T3** Add source attribution, original link storage, late-inference protection and lifecycle cleanup. Dropped is a reversible status; permanent delete removes the candidate's independent media/evidence.

Acceptance:

1. **P4.01-A1 — E2E/DB:** Screenshot/manual entry persists corrected title/variant/price; missing price is not zero, currency is explicit and late extraction cannot undo edits.
2. **P4.01-A2 — Integration:** Wishlist candidate never appears as owned or increments wear/catalog counts. Foreign owner/asset/status mutations fail.
3. **P4.01-A3 — E2E:** Zero allowance allows save/edit/status/delete; pending extraction preserves useful manual candidate. Reopening does not rerun paid extraction.
4. **P4.01-A4 — Integration:** Delete/cancel removes unused media and job payloads; active worker cannot recreate candidate; safe analytics excludes product URL and entered title.

## P4.02 — Import a product link with a bounded preview fallback

**Depends on:** P4.01 and P0.04.  
**Demo:** Paste an eligible Uniqlo link, review public preview fields; a blocked store retains the link and offers screenshot/manual entry.

Tasks:

- [ ] **P4.02-T1** Add preview job through an owner-authorized command, e.g. `POST /wishlist-previews`. Implement worker HTTPS-only fetch with DNS/address checks on every connection/redirect, no userinfo/cookies, restricted ports, redirect/byte/time limits and MIME validation.
- [ ] **P4.02-T2** Validate preview image URLs through the same fetch policy; decode/sanitize into private candidate assets only where supported. Parse bounded public metadata; never execute remote JavaScript or treat page text as model instructions.
- [ ] **P4.02-T3** Define safe tracking-parameter normalization, attribution, extraction field source and stale-result rules. Preserve link/edited values through blocked/timeout outcomes and display immediate fallback rather than endless retry.
- [ ] **P4.02-T4** Test current Uniqlo behavior on staging and use generic screenshot/manual fallback for Shein/Zalora/Shopee/Lazada or unavailable pages. Record supported formats/sites without promising arbitrary scraping.

Acceptance:

1. **P4.02-A1 — Worker/integration:** Loopback/private/link-local/metadata targets, DNS changes, redirect escape, oversized bodies/images, wrong MIME and credentialed URLs fail without reaching protected destinations. Error logs contain no sensitive URL query.
2. **P4.02-A2 — E2E/staging:** Supported Uniqlo public preview returns editable fields; block/timeout preserves the URL and reaches screenshot/manual entry. A redirect/image URL gets the same defenses as the original page.
3. **P4.02-A3 — Integration:** Duplicate import completion creates one candidate result; stale preview cannot replace a user's edits. Injected page instructions cannot alter tools, budget or owner.
4. **P4.02-A4 — E2E:** No remote cookies or code execute in the app; opening an existing preview charges/fetches nothing again. Cancellation leaves no unreferenced media.

## P4.03 — Inspect computed factors and a bounded verdict

**Depends on:** P4.01–P4.02 and P3.01–P3.02.  
**Demo:** Request a verdict, compare owned duplicates, inspect complete outfit unlocks, and change a wear-frequency assumption for projected cost-per-wear.

Tasks:

- [ ] **P4.03-T1** Compute same-category duplicates, distinct complete combinations containing a hypothetical candidate, coverage and bounded-search flag using existing engines. Candidate is never persisted as owned just to run the analysis.
- [ ] **P4.03-T2** Compute projected cost-per-wear from visible price and explicit wear-frequency/time-horizon assumptions, with observed similar-item history shown if available. Label projections separately from historical Birdseye values.
- [ ] **P4.03-T3** Use a versioned factor object with unavailable reasons. Taste distance and palette/proportions remain unavailable until phase 6 has opted-in usable data; lack of optional profile cannot block other evidence or a qualified verdict.
- [ ] **P4.03-T4** Add guarded verdict request with candidate/closet/profile revisions and evidence IDs, Buy/Think/Skip, two supported reasons, timestamp, cached restoration and invalidation. Build factor detail UI and Birdseye Save to Shinies; insufficient evidence yields an explicit insufficient-information state.

Acceptance:

1. **P4.03-A1 — Domain/DB:** Fixture duplicate and unlock counts match inspectable unique complete combinations; repeated permutations and partial outfits do not inflate counts. Sparse data identifies unavailable factors.
2. **P4.03-A2 — Domain/E2E:** Projection exposes assumptions and changes correctly; missing price/zero assumed wears/currency mismatch cannot display misleading zero/infinite value. It is never labeled historical cost-per-wear.
3. **P4.03-A3 — Integration:** Verdict cannot invent factors/numbers, foreign garments or a nonexistent profile. Changed candidate/wardrobe marks old verdict stale; opening it makes no call.
4. **P4.03-A4 — E2E:** Paused AI retains list and computed factors, with no fabricated new AI verdict. Uniqlo link and Shein screenshot each return an actual guarded supported verdict in the normal-mode pilot.

## P4.04 — Confirm “I bought it” exactly once

**Depends on:** P4.01–P4.03.  
**Demo:** Confirm variant/paid price, retry a lost response and find one owned item; replace its product photo later without losing identity.

Tasks:

- [ ] **P4.04-T1** Add a durable unique wishlist-to-item mapping and `purchase_wishlist_item` RPC. Lock candidate/revision and check duplicates; either explicitly link an existing owned item or create one with user-confirmed variant/price and source.
- [ ] **P4.04-T2** Prepare an independent validated retained asset before final transaction, or use a well-defined atomic attachment/ownership transfer. Publish item + mapping + Bought together; failed copy/preparation cannot mark Bought. Clean unpublished copies on cancellation/failure.
- [ ] **P4.04-T3** Add confirmation, existing-item choice, saved result, Take my own photo and shared reshoot action. Candidate deletion cannot remove purchased item's images; buying never records a wear.

Acceptance:

1. **P4.04-A1 — Integration:** Double tap, concurrent clients and lost response produce one mapping/owned piece and one Bought transition. Changed body/key conflict cannot silently overwrite purchase details.
2. **P4.04-A2 — Integration:** Fail asset preparation or DB commit: no half-purchased state; retry recovers safely and orphan cleanup removes unpublished copies. Foreign existing-item link fails.
3. **P4.04-A3 — E2E/DB:** Bought item appears in Bower with correct variant/currency/source; wear rows remain unchanged. Delete wishlist source and verify owned media survives; reshoot keeps item ID.
4. **P4.04-A4 — E2E:** Screenshot fallback → review → verdict → purchase → manual outfit/log is complete, including manual purchase when AI is paused.

## Phase exit and rollback

- [ ] Current Uniqlo-link and Shein-screenshot acceptance paths produce actual supported verdicts and recover from preview failure.
- [ ] Factors are inspectable, optional-profile gaps honest, and purchase is idempotent across storage/DB failure.
- [ ] New URL/media/report data obeys deletion, isolation and analytics rules.

Disable preview or verdict generation independently; preserve manual wishlist and purchase paths. Roll back with Bought mappings and owned assets retained. Never undo a recorded real purchase or delete an owned item because a preview adapter failed.
