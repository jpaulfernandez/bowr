# Phase 3 — Birdseye: evidence before advice

**Outcome:** Members inspect exact wardrobe measures and on-demand interpretations grounded in those measures.  
**Depends on:** [Phase 2 MVP gate](phase-02-arrange-and-strut.md).  
**Sources:** [PRD F6](<../../bowr — PRD.md>); [DESIGN §§7.1, 13.2](../../DESIGN.md); [ARCHITECTURE §§11.3, 13](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-04-shinies.md).

## Entry and scope

Use existing items, embeddings and confirmed wear history; no parallel analytics database or mutable counters. Introduce cached `insight_reports` only for persisted expensive commentary. All charts/tables must work without AI. Wishlist actions arrive in phase 4, fit-profile context in phase 6.

## P3.01 — Inspect exact wardrobe and wear measures

**Depends on:** Phase 2.  
**Demo:** Open Birdseye, inspect category/color/formality/season and logged-wear measures, drill into the contributing pieces, then correct a log and see the measure update.

Tasks:

- [ ] **P3.01-T1** Extend `get_wardrobe_stats` with scoped counts, breakdowns, distinct local wear dates, most/least/never logged, price/currency and observation coverage. Define active versus archived selection and date-range semantics explicitly.
- [ ] **P3.01-T2** Record a versioned metric dictionary with numerator, denominator, missing-value and multi-value rules. Planning default: category counts once/piece; primary-color distribution counts the dominant named color once; season memberships may overlap and say so; unknown values remain visible. Wardrobe composition is current, while selected dates filter wear history.
- [ ] **P3.01-T3** Build `/wardrobe/insights` from Bower/More with Overview, Wear history, Opportunities, date range, coverage, calculation time, labeled bars and table equivalents. Drilldowns use the same query filters as displayed totals.
- [ ] **P3.01-T4** Show per-logged-wear-day price only with known price/currency and positive distinct-date count. Keep currencies separate; differentiate not-logged-since-added from ≥90-day observation. Invalidate results after item/log mutation.

Acceptance:

1. **P3.01-A1 — Domain/DB:** HISTORY fixture gives exact expected counts after two same-day fits, date correction, archive and deletion; no saved/loved/rated outfit creates wear evidence.
2. **P3.01-A2 — DB/E2E:** Missing price/zero wear days shows unavailable, explicit zero price remains zero, and PHP/USD are not summed. Unknown categories/colors and overlapping seasons have honest denominators.
3. **P3.01-A3 — E2E:** Early account cannot claim 90-day non-use; recently added pieces show their shorter observation window. Every breakdown row opens precisely its contributing set.
4. **P3.01-A4 — Accessibility/integration:** Chart and table values match; zero AI/provider outage changes no computed totals. B cannot query A's aggregate or drilldown by forged scope.

## P3.02 — Inspect duplicates, balance and wardrobe gaps

**Depends on:** P3.01 and phase-1 current embeddings.  
**Demo:** Compare two similar shirts, inspect palette/category/versatility definitions, and open the real combinations behind a suggested missing shoe.

Tasks:

- [ ] **P3.02-T1** Implement same-category/version near-duplicate candidate retrieval with measured thresholds and side-by-side comparison. Treat the PRD's sample threshold as a calibration starting point, never automatic merge authority.
- [ ] **P3.02-T2** Add defined descriptive measures: versioned neutral/accent mapping with unknown group, raw top:bottom:shoe counts, and versatility as distinct current complete saved compositions containing a piece. This denominator is a planning definition; show it and exclude duplicated named compositions/partial outfits from the count.
- [ ] **P3.02-T3** Build a bounded deterministic combination evaluator using common slot/eligibility rules. Represent hypothetical missing basics as candidate descriptors outside owned items; return actual supporting combination IDs/descriptors and whether search is exhaustive. Count distinct complete combinations, not pairwise compatibility.
- [ ] **P3.02-T4** Render Opportunities with observation, interpretation and action; expose assumptions and inspection. Keep Save to Shinies hidden until phase 4. Scrub deleted piece details from any cached measure/evidence.

Acceptance:

1. **P3.02-A1 — Worker/DB:** Duplicate pairs are owner-scoped, symmetric/deduped and model-compatible; identical real garments are not merged. Archived/deleted items follow the stated report scope.
2. **P3.02-A2 — Domain/E2E:** Fixture balance/versatility values and sample sizes match the dictionary; no unexplained health score or universal ideal is displayed.
3. **P3.02-A3 — Domain/DB:** Gap enumerator counts unique complete combinations containing its hypothetical candidate. Sparse wardrobes, repeated permutations and accessories cannot inflate the total; bounded searches say combinations found.
4. **P3.02-A4 — E2E/integration:** View combinations matches displayed evidence; deleting an underlying item invalidates/scrubs old details. A hypothetical candidate never becomes an owned wardrobe item.

## P3.03 — Ask for grounded insights and verify their usefulness

**Depends on:** P3.01–P3.02 and P0.05.  
**Demo:** Request commentary, inspect three facts and their evidence, reopen it without another charge, then change source data and explicitly refresh.

Tasks:

- [ ] **P3.03-T1** Add owner-scoped insight request/report with stats hash, metric schema/version, coverage, input revisions and model/prompt version. Use the shared gateway with aggregate facts only; no photos or raw private logs.
- [ ] **P3.03-T2** Require structured observation/fact IDs, interpretation and action references. Reject fabricated numeric claims or nonexistent evidence references; validate numbers against supplied computed facts before publishing.
- [ ] **P3.03-T3** Build explicit Generate/Refresh, cached creation time, stale-source notice and no-AI state; existing charts remain available. Add safe `insights_viewed` and release evidence including owner feedback.

Acceptance:

1. **P3.03-A1 — Integration:** Inject a narrative containing false totals, unsupported fit-profile claims or foreign IDs: reject/omit invalid content instead of displaying it as fact. Every published numerical observation resolves to current supplied evidence.
2. **P3.03-A2 — E2E/integration:** Reopen produces zero additional calls; source change marks stale and explicit refresh reserves a new attempt. Paused AI preserves charts and prior appropriately labeled report.
3. **P3.03-A3 — Human:** Owner identifies at least three useful/agreeable observations, with supporting data recorded. Agreement is not proof of causal or scientific correctness.
4. **P3.03-A4 — Integration:** Item/account deletion scrubs report references; no sensitive measure/prompt is emitted to analytics. Shared budget and access matrix pass for the new request path.

## Phase exit and rollback

- [ ] Every number has a tested definition, scope, coverage and empty-data behavior; table equivalents and drilldowns match.
- [ ] The owner agrees with at least three grounded observations; manual computed insights work at zero allowance.
- [ ] Gap/duplicate evidence cannot imply ownership or certainty it does not have.

Disable narrative generation independently and continue computed views. Invalidate reports by metric/version/input hash on rollback or formula change; never alter historical wear records to repair a report.
