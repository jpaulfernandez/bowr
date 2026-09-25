# Vertical-slice test and evidence strategy

**Status:** Proposed test contract. No application tests exist yet.  
**Sources:** [ARCHITECTURE §§8–12, 14–16](../../ARCHITECTURE.md), [DESIGN §§10–14](../../DESIGN.md).  
**Navigation:** [Plan](README.md).

## Test layers

| Label used in phase files | Tool / environment | What it proves |
| --- | --- | --- |
| Domain | Vitest, pure TypeScript | Slots, completeness, date/currency rules, input schemas, cost envelopes |
| DB | pgTAP on local Supabase | RLS, grants, same-owner relationships, constraints, RPC atomicity |
| Integration | Concurrent independent clients + real local DB; deterministic provider/storage adapters | Race behavior, lost responses, worker callbacks, reservation/settlement, external failure reconciliation |
| Worker | pytest and pinned image/model fixtures | Decode limits, geometry, metadata stripping, color/vector contracts, URL defenses |
| E2E | Playwright against web + local Supabase + test adapters | Full routes and user choices through persisted outcome; axe on relevant screens |
| Staging | Isolated provider accounts, synthetic or explicitly consented data | R2/CORS/signing, Modal dispatch, OAuth/SMTP, actual paid-model behavior and billing |
| Device / human | Actual phone browsers; native devices in phase 8; owner/friend pilots | Camera, screen reader, touch, perceived quality, usability, real install/share/push |

Database race tests use separate transactions/connections, synchronization barriers, and deterministic assertions. Do not claim a sequential unit test proves concurrency. Fake adapters must expose call counts and controlled outcomes; E2E checks should still exercise actual server authorization and transactions. A completely mocked frontend is not slice acceptance.

Phase 0 creates documented scripts for these layers, contract generation/drift checks, lint/type checks, migration reset, web export, and worker-image build. Record the actual commands once the repository is scaffolded; this plan does not pretend those commands already exist.

Run focused relevant checks while implementing. Before a phase release, run its cross-slice journey plus the shared invariants it could affect. Before MVP release, run the full MVP critical suite once against the release candidate. Repeat only after changes, failures, or unresolved concerns.

## Environment and data controls

- Local: seeded Supabase and deterministic provider adapters; no billable network calls in default CI.
- Staging: separate Auth, R2, Modal, Gemini, analytics and callback configuration. Preview builds never point at production.
- Production: immutable tested artifacts; feature flags off until gates pass; narrow non-billable smoke checks after deploy.
- Never commit secrets, raw private photos, signed URLs, body measurements, invite codes, or provider payloads as test evidence. Store consenting-user evaluation images privately; commit a redacted manifest and aggregate results.
- Paid smoke, evaluation, repair, and search calls use the gateway and a declared bounded run budget. Multiple development/staging projects do not create permission to exceed the owner's intended shared AI spend; record how evaluation spend is allocated before running paid evaluations.

## Shared fixtures

Create each fixture when the first slice needs it; do not prebuild all later domains.

| Fixture | Contents / purpose | First use |
| --- | --- | --- |
| AUTH | Anonymous, pending, A, B, owner, suspended, deleting identities; similar-looking records owned by A/B | P0.01 |
| INVITES | Fresh single-use, expired, revoked, exhausted, concurrent redemption; pending account near 24-hour cleanup | P0.02 |
| MEDIA | JPEG/PNG/WebP/HEIC, rotated EXIF/GPS, corrupt, spoofed MIME, animated, 20 MiB boundary, 40 MP boundary, label, grouped accessories | P0.03 |
| JOBS | Lost wake-up, worker death, lease expiry, stale generation, duplicate callback, canceled target, partial object write | P0.04 |
| BUDGET | Controlled clock and usage near $8/$9.50/$10, zero stop, unknown timeout, tariff switch, UTC month boundary, bad usage totals | P0.05 |
| WARDROBE | Complete top/bottom/shoes, dress/shoes, sparse closet, every accessory category, archived/deleted/unreviewed items; 50 and 300-piece sets | P1.01 |
| INFERENCE | Delayed tags, intentional empty user edit, late crop, embedding failure, wrong model version, label conflict, invalid structured output | P1.02 |
| HISTORY | Same jacket on two fits/day, another day, duplicate requests, genuine repeat event, local dates around midnight/travel, zero/missing prices and separate currencies | P2.02 |
| MATCH | Consented known mirror-photo pieces, similar duplicates, occlusion, unknown piece, shoes/eyewear/jewelry/dress and foreign-owner decoys | P2.04 |
| URLS | Allowed preview, block/timeout, redirect to private/metadata address, DNS change, oversize body/image, wrong MIME, injected page instructions | P4.02 |
| REFERENCES | Brief/reference edits, unavailable thumbnails, named-person source links, missing wardrobe slots, include/avoid contradictions | P5.01 |
| COLOR | Synthetic/consented light variations, missing white reference, inconsistent three shots, A/B/tie votes, incomplete measurements | P6.01 |
| SOCIAL | Sharer, two recipients, nonrecipient, revoked recipient, suspended recipient, expired poll, deleted source, prior signed image | P9.01 |

## Standard acceptance format

Every phase lists numbered cases under each slice. Expand each into a test or recorded manual protocol with setup, action, expected outcome, and cleanup. Keep the IDs stable when turning tasks into issues.

Example for `P2.02-A2`:

1. Seed A with three active owned pieces and one reviewed fit draft at a known revision.
2. Submit two simultaneous confirmations with the same request identity; simulate losing one response and fetch the existing result.
3. Assert both successful reads resolve to the same fit ID, exactly three wear rows exist, one source draft is linked, and one commit event was emitted.
4. Repeat with different keys for the same draft; the durable draft uniqueness still prevents a second fit.
5. Assert no second outfit-library entry, second photo promotion, or duplicate event was created; remove the test account through its normal cleanup path.

A screenshot proves presentation. A query proves rows. An object inventory proves deletion. A provider-adapter trace proves dispatch counts. Use the evidence type appropriate to the invariant.

## Shared release checks

| Gate | Required assertion |
| --- | --- |
| Access | Every new table/view/RPC/API/job/media route rejects anonymous, pending, foreign, suspended and deleting identities; owner role does not confer private wardrobe access |
| Authority | No caller can set ownership, roles, membership, object keys, completion state or spend; API errors do not reveal another user's object existence |
| Request identity | Same key/body returns the same outcome; changed body with same key conflicts; reload does not regenerate or charge; resource-level uniqueness survives old request-record expiry |
| Revisions | Concurrent changes return conflict or apply to untouched fields only; stale jobs cannot revive canceled/deleted data |
| AI | Schema plus owned-ID validation, task bounds, gateway-only invocation, zero-stop manual path, no automatic paid retry after ambiguous dispatch |
| History | Confirm is the only wear path; corrections are atomic; snapshots do not track later outfit changes; counts use distinct local dates |
| Lifecycle | User sees retention choice and truthful pending deletion; object checks cover derivatives, signed-upload replay, late workers, caches and restoration |
| Accessibility | Visible focus, names/statuses, keyboard alternatives, screen reader, reduced motion, 44 px product target, 320 px reflow, 200% text, calendar/text equivalents |
| Analytics | Explicit events only, autocapture/recording/automatic URL capture off, no prohibited fields; post-commit effects deduped; logout clears identity |
| Operations | Compatible deployment and rollback, scheduler heartbeat, stuck-work and deletion alerts, measured capacity, recovery runbook |

## Performance protocol

Use a release build, documented midrange phone and representative Manila network profile. Record device/OS/browser, fixture size, connection, cold/warm state, sample count, median and p95. Run at least 30 samples for deterministic/non-billable interactions as an initial planning default. For paid inference, start with the PRD-sized pilot under the budget; report small-sample results plainly and do not call a ten-request sample a reliable production p95.

Targets inherited from ARCHITECTURE §15.2:

| Journey | Target |
| --- | --- |
| Local selection/pending state | ≤100 ms |
| Useful first wardrobe page | ≤3 s p95 |
| Metadata search/filter or manual save acknowledgement | ≤1.5 s p95 |
| Accepted processing command, excluding upload | Job identity ≤1 s p95 |
| Ordinary cutout after validation | Warm ≤15 s; cold ≤60 s p95 |
| Arrange | Warm ≤15 s p95 |
| Fit recognition | Warm ≤20 s p95 |
| Phase-5 Forage pilot | Each named PRD case produces two wearable outfits within 15 s of machine processing, including search when used |

For review-driven Forage, measure brief/search time and generation time separately and sum machine time; exclude only the user's deliberate reading/editing pause. Also record wall-clock session duration. Do not omit search, hide cold starts, or meet latency by skipping reference review. State when a small evaluation establishes only pilot latency rather than p95.

## Human evaluation and product measures

- Extraction: the PRD's 20 owned pieces, covering garments and accessories; prelabel expected tags and distinguish visual inference from label facts. Report per-field accuracy and per-piece acceptance without edits. The 80% target is a pilot signal until sufficient observations accumulate.
- Outfit model selection: same ten real requests, blind 1–5 wearability ratings, same constraints and prompts. Compare currently available approved paid candidates; select the cheapest within the documented approximately 10% quality tolerance. Record cost and invalid-output rate separately.
- Recognition: preselect ten identifiable garment instances across representative fit photos, not ten cherry-picked successes. Correct top proposed item before correction is the numerator; unknown/no-match cases are reported separately. Require at least 8/10 for the PRD pilot and publish the sample limitation.
- Habit: five actual consecutive local dates of owner logging for phase 2. Time-travel fixtures test date logic but cannot substitute for the real pilot.
- Usability: DESIGN §14.2 tasks on actual phones. With five participants use its proposed thresholds; with three, record every failure and fix blocking ones. No population-level claims.
- First-three-month measures: digitized share requires an optional self-reported wardrobe denominator; outfit-choice usage is observed separately from saved/worn events; 90-day reactivation requires a prior observation baseline; otherwise show insufficient history. AI actual/reserved/unknown totals stay distinguishable.

## Evidence record

Create `docs/implementation/evidence/P<phase>.<slice>.md` during implementation with:

```text
Slice ID and outcome:
Commit / build / migration / contract versions:
Environment, device, fixtures, controlled clock:
Acceptance ID -> command or manual steps -> result:
DB/object/ledger evidence (redacted):
Accessibility / recovery / zero-AI checks:
Performance or quality sample and limitations:
Deployment flag and rollback rehearsal:
Remaining failures / withheld gates / responsible follow-up:
Reviewer and verification date:
```

Phase exit evidence links every slice result and records the actual demo. A failed gate is left unchecked with a reproducible failure and next task. Do not label release-ready based on proposed tests, static documents, or simulated provider success alone.
