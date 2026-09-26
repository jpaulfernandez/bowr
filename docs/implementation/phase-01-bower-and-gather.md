# Phase 1 — Gather and a usable Bower

**Outcome:** Fifty real pieces are usable, searchable, editable and privately stored; current embeddings are ready for phase-2 recognition.  
**Depends on:** [Phase 0](phase-00-foundations.md), including privacy, budget and recovery gates.  
**Sources:** [PRD F1–F2](<../../bowr — PRD.md>); [DESIGN §§4.5, 6.2–6.4, 8–11](../../DESIGN.md); [ARCHITECTURE §§6.3–6.4, 7–10, 12](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-02-arrange-and-strut.md).

## Entry and scope

Use the existing upload, asset, worker, gateway and cleanup paths. Implement `items`, `item_assets`, `item_suggestions` and versioned `item_embeddings` as their slices need them. Keep lifecycle, processing stage and review status separate. No outfits or logged-wear claims yet; phase 2 supplies wear data and activates those actions/sorts.

## P1.01 — Add one piece and correct it without AI

**Depends on:** Phase 0.  
**Demo:** Upload a shirt, see a cutout in Bower, edit its category/name and reopen it while AI is paused.

Tasks:

- [x] **P1.01-T1** Add item/asset relationships and unique upload-entry/part creation identity; implement owner-filtered paginated reads, `update_item`, field provenance, taxonomy and revision conflicts. Preserve all first-class garment/accessory categories.
- [x] **P1.01-T2** Connect validated uploads to one visible ordinary item and cutout/mask/thumbnail stages. Produce transparent square 1024 px cutout and 256 px thumbnail from the sanitized original; masked image work uses pinned CPU models.
- [x] **P1.01-T3** Build `/wardrobe`, `/wardrobe/gather`, `/wardrobe/uploads/:id`, `/wardrobe/items/:id` with stable tiles, Cutout/Original, editable name/category/colors and collapsed optional metadata. Add guide entry, take/choose photo, rotate/remove and first-upload guidance.
- [x] **P1.01-T4** Add Use original, retry stage, manual category and needs-attention states. Eligibility depends on resolved metadata, not all processing succeeding; no AI call is required for manual identification.

Acceptance:

1. **P1.01-A1 — E2E/DB:** Upload → cutout → edit → reload yields one persistent piece with correct assets. Repeated completion cannot create another piece; optional brand/price/date remain optional.
2. **P1.01-A2 — Worker/E2E:** Cutout failure preserves a viewable original and manual correction. Embedding or AI unavailability cannot prevent manual editing. Failed processing is not mislabeled ready.
3. **P1.01-A3 — DB/integration:** A cannot edit/attach B's item or assets; simultaneous stale revisions return conflict rather than silently losing a correction.
4. **P1.01-A4 — Device:** Guide, file-picker alternative, named swatches and stable image layout work at phone size, keyboard and enlarged text. Piece detail labels original as the sanitized version in help/privacy copy.

## P1.02 — Receive tags, colors and embeddings without losing edits

**Depends on:** P1.01 and P0.05.  
**Demo:** A new piece fills in suggested tags; change material while tagging runs, then verify that correction survives and the current item can be retrieved by its embedding.

Tasks:

- [ ] **P1.02-T1** Implement independent foreground-color, normalized 512-dimensional FashionCLIP and guarded structured-tag stages. Version model/preprocess/media/prompt/schema identities; reject incompatible vector spaces. Include shoe, eyewear, headwear and accessory attributes.
- [x] **P1.02-T2** Persist bounded suggestions separately; apply only unchanged, unlocked field versions from the current media revision. User-cleared values remain locked. Offer explicit Use suggestion; mark inferred material and uncertain category honestly.
- [x] **P1.02-T3** Validate category/subcategory/formality/seasons/tags and output size at worker/API/DB boundaries. Build owner-filtered exact vector retrieval for later matching; no approximate index or new vector service.
- [x] **P1.02-T4** Expose processing/review states and explicit retry. Resolve safe retained-item blocked tagging after budget reset, but never regenerate on page open or retry ambiguous billed calls automatically.

Acceptance:

1. **P1.02-A1 — Integration/E2E:** Late vision/label suggestions fill untouched fields but do not overwrite edited or intentionally cleared fields. Old media results cannot update a replacement image's colors/vector.
2. **P1.02-A2 — Worker/DB:** Vectors are finite, normalized, correctly dimensioned/versioned; exact retrieval sees A's compatible embeddings only, even when B has a closer match.
3. **P1.02-A3 — Integration:** Invalid categories/JSON, prompt-like text in a label and unknown attributes cannot change authority or bypass schemas. Failure preserves canonical manual metadata and safe status.
4. **P1.02-A4 — E2E/integration:** Zero budget still permits upload/cutout/manual category. Matching eligibility waits for current embedding; tag-based outfit eligibility will not require one. Retry/reopen preserves call counts.

## P1.03 — Gather a mixed batch with care labels

**Depends on:** P1.01–P1.02.  
**Demo:** Add twenty source photos including care labels; one fails, successful pieces remain and the failed file can be retried alone.

Tasks:

- [x] **P1.03-T1** Expand the Gather queue to 20 source photos including labels, three concurrent uploads, thumbnail rotate/remove/add, per-file progress and uploaded-versus-unsent distinction. Desktop drop is optional beside file input.
- [x] **P1.03-T2** Implement optional care-label attachment to a selected queue garment or existing item, independent label reading and editable brand/size/material. A label never creates another wardrobe piece.
- [x] **P1.03-T3** Deliver `/help/photos` with hanger/flat-lay and shoe, shades, hat, bag, belt, watch/jewelry guidance from the PRD. Make guidance reopenable and category-specific; no native framing outline until phase 8.
- [x] **P1.03-T4** Add batch review and needs-attention filtering; successful ordinary tags do not need mandatory approval. Resume uploaded work by batch ID; retry only failed entries and keep stable source identities.

Acceptance:

1. **P1.03-A1 — E2E/integration:** Exactly 20 source files including labels are accepted; a twenty-first fails clearly before signing. Mixed corrupt/network/valid files preserve all successful items and label relationships.
2. **P1.03-A2 — E2E:** Close after some uploads finish; reopening resumes those files without recharging/recreating items, and identifies unsent files for reselection. No claim of background browser upload is made.
3. **P1.03-A3 — Worker/integration:** A readable label fills unlocked brand/size/material; unreadable/removed label leaves garment usable. Removing the attachment deletes its assets, while already approved canonical tags remain.
4. **P1.03-A4 — Device/accessibility:** Camera denied, keyboard-only file selection and a 20-row mixed-status queue remain operable; status announcements do not overwhelm screen readers.

## P1.04 — Split accessories and resolve probable duplicates

**Depends on:** P1.02–P1.03.  
**Demo:** Keep earrings as one set, split a watch/bracelet into two pieces, and resolve a reupload using Use existing or Add another.

Tasks:

- [ ] **P1.04-T1** Add grouped-photo choice and crop proposals/manual rectangles. Require Keep as one set or explicit selected parts; validate normalized oriented coordinates and maximum 20 parts/source. No automatic multi-item creation.
- [ ] **P1.04-T2** Implement `confirm-parts` atomically with stable source-part IDs, independent normalized item crops and jobs. Shared grouped original stays temporary; confirmed item assets get independent lifecycle.
- [ ] **P1.04-T3** Add same-owner sanitized hash and category/vector duplicate comparisons, with Use existing, Add another, Decide later. Delay creating a second item when a duplicate decision is pending; intentional identical garments remain distinct.
- [ ] **P1.04-T4** Support manual crops/keep-one with AI paused; retain label-to-item assignment and clean rejected crops/source media through the existing deletion service.

Acceptance:

1. **P1.04-A1 — E2E/DB:** No new pieces before split confirmation; confirming two parts twice creates exactly two items. A kept earring set creates one item. Result count can exceed source-photo count without exceeding part limits.
2. **P1.04-A2 — Integration:** Out-of-bounds/tiny/mismatched-orientation crops and more than 20 selected parts fail safely, with the draft preserved. Overlap alone does not imply duplicate garments or trigger an automatic merge.
3. **P1.04-A3 — E2E/DB:** Use existing creates no duplicate; Add another creates a separate owned ID/assets; Decide later survives reopening. No global hash collision reveals another wardrobe.
4. **P1.04-A4 — Integration:** Cancel, delete one confirmed part, and clean the grouped source: unrelated confirmed part remains viewable. Stale split completion cannot recreate removed parts.

## P1.05 — Repair or replace a piece photo reversibly

**Depends on:** P1.01–P1.02.  
**Demo:** Fix a poor eyewear edge, undo/reset it, then reshoot the same piece without changing its identity.

Tasks:

- [ ] **P1.05-T1** Build web mask-editor adapter with Restore/Erase, brush size, zoom, undo/reset and explicit accessible alternatives. Keep Use original and alternate-model retry available when brushing is impractical.
- [ ] **P1.05-T2** Submit mask assets tied to original/media revision; validate dimensions and compose server-side. Increment media revision for accepted mask/crop/replacement and recompute affected thumbnails/colors/embeddings.
- [ ] **P1.05-T3** Implement replace/reshoot on the existing item ID, with safe pending publication and cleanup of superseded unreferenced assets. Preserve user metadata and source/history relationships.

Acceptance:

1. **P1.05-A1 — Worker/E2E:** Restore/erase/undo/reset alter only the intended mask; original remains available. Forged trusted-cutout bytes or mismatched masks are rejected.
2. **P1.05-A2 — Integration:** Start old inference, replace the photo, finish old job: current asset/color/vector stays unchanged. Simultaneous corrections return a revision conflict.
3. **P1.05-A3 — E2E/DB:** Reshoot retains the item ID and user metadata; failed replacement leaves a usable prior image. Superseded assets are cleaned only after references are detached.
4. **P1.05-A4 — Device:** Touch, zoom and keyboard controls are usable; a person unable to draw can complete through original/retry/replace. Alternate-model retries are bounded and never cycle automatically.

## P1.06 — Find, organize, archive and permanently delete pieces

**Depends on:** P1.01–P1.04.  
**Demo:** Find shades among 50 pieces, bulk-correct a category, archive/restore, and permanently delete a test piece with verifiable asset removal.

Tasks:

- [ ] **P1.06-T1** Implement text/tag/synonym search, OR within facets and AND across facets, stable cursor pagination, recently-added/category/color/name sorting and active filter chips. Preserve filters/scroll on detail/back. Add 50/300-item fixtures and lazy thumbnails.
- [ ] **P1.06-T2** Implement accessible visible bulk Select, up-to-100 revisioned category/archive operations, lifecycle restore and counts excluding archived/deleted with processing reported separately. Never silently skip stale selected rows.
- [ ] **P1.06-T3** Implement permanent item deletion: neutral tombstone, reusable attributes/vectors/suggestions scrubbed, attached original/cutout/thumbnail/mask/labels queued for deletion, late jobs fenced. Extend the lifecycle registry as later referencing domains are added.
- [ ] **P1.06-T4** Expose empty/no-results/image-error/archive states and explicit delete consequences; no wear statistics before phase 2. Emit safe item-added/reviewed/upload events after the relevant successful action.

Acceptance:

1. **P1.06-A1 — Domain/DB/E2E:** “Shades” finds eyewear and “pants” finds bottoms; combined facets yield exact expected IDs. Cursor navigation has no skipped/duplicate rows on stable fixtures; malformed/sort-mismatched cursors fail.
2. **P1.06-A2 — Integration:** Foreign or stale IDs abort a bulk mutation with no partial silent success. Archive excludes automatic eligibility; restore returns the same ID/data.
3. **P1.06-A3 — Integration/staging:** Delete denies new access immediately and eventually proves all relevant object absence; storage outage shows pending. Canceled old worker and replayed PUT cannot restore the piece.
4. **P1.06-A4 — Device/performance:** Representative 300-piece Bower meets first-page/search targets with stable tiles; find-a-piece usability task and filter reset work. Inspect events for private names/photos/URLs.

## P1.07 — Validate a fifty-piece wardrobe and extraction choice

**Depends on:** P1.01–P1.06.  
**Demo:** Owner catalogs fifty real mixed pieces and can find and correct them; evaluation records the cost/quality of candidate extraction models.

Tasks:

- [ ] **P1.07-T1** Run the PRD's twenty-piece blind extraction comparison across currently available approved paid candidates using identical prompts, labels and schemas. Record per-field accuracy, unedited acceptance, invalid output, latency and guarded cost.
- [ ] **P1.07-T2** Pin the cheapest candidate within approximately 10% of the best quality, or record that no candidate passes and keep the gate open. Verify licenses/weight integrity and memory/CPU/cold-start limits for cutout and FashionCLIP.
- [ ] **P1.07-T3** Catalog fifty owner-approved pieces including shoes, dresses and difficult accessories; correct bad cutouts/tags, verify matching-ready vectors, and measure actual storage/compute. Test phone camera formats and mixed-batch recovery.

Acceptance:

1. **P1.07-A1 — Human/staging:** Fifty distinct owned pieces have owner-accepted cutouts and usable identifying metadata; every unresolved problem has a record, not an assumed clean result.
2. **P1.07-A2 — Evaluation:** Dataset, blind method, model/config versions, denominators and cost are recorded. Compare observed unedited tag acceptance with the PRD's 80% target; do not imply a small pilot establishes universal accuracy.
3. **P1.07-A3 — Worker/staging:** Current embeddings exist for the recognition pilot pieces; benchmark cold/warm cutout targets, memory and storage with limitations stated. Unknown licenses/formats block their enablement.
4. **P1.07-A4 — E2E/device:** Entire add→correct→find→archive/restore flow succeeds at zero AI allowance; accessibility, privacy, deletion and account-switch checks pass for new surfaces.

## Phase exit and rollback

- [ ] F1–F2 journeys and fifty-piece pilot pass; grouped/label/duplicate/repair cases are demonstrated.
- [ ] Late inference never overrides user/media revisions; matching infrastructure is usable before phase 2.
- [ ] Resource/format/model evidence and remaining quality limitations are recorded.

Pause inference or new upload admission independently, preserving existing Bower/manual edits. Roll back compatible worker/model configuration without comparing incompatible embeddings. Retain original/media versions until safely detached; never clear canonical edits to rerun extraction.
