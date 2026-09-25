# Phase 9 — Flock: selected sharing and private polls

**Outcome:** A member explicitly shares one selected object with named friends; two recipients can vote, and revoked recipients lose future access without gaining wardrobe access.  
**Depends on:** Completed prior roadmap phases; source objects come from phases 2 and 4. Shared contracts serve web and native.  
**Sources:** [PRD F10](<../../bowr — PRD.md>); [DESIGN §7.6](../../DESIGN.md); [ARCHITECTURE §§12, 13.3](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md).

## Entry and scope

Add `shares`, normalized `share_recipients`, `share_assets`, `polls` and `poll_responses`. Social remains hidden until recipient grants and revocation pass. No public links/profiles, follower model, automatic closet sharing, leaderboard or general friend access to source tables.

The new share/poll APIs below are proposed narrow contracts, using the existing ownership, idempotency, revision and lifecycle pattern. Membership admission and an individual share grant remain distinct.

## P9.01 — Preview and share only a selected payload

**Depends on:** Phase-2 outfit/log and phase-4 wishlist objects; existing media/deletion infrastructure.  
**Demo:** Select one outfit, inspect the exact payload, choose two friends with nobody preselected, and publish only those approved fields/assets.

Tasks:

- [ ] **P9.01-T1** Define versioned allowlists per source type: outfit composition/text, chosen fit-log fields and optional explicitly included retained photo, wishlist candidate/verdict fields. Exclude body profile, selfies, private notes and paid wardrobe prices; any prospective product price inclusion must be visible in the wishlist preview.
- [ ] **P9.01-T2** Add share/recipient/asset schema with same-owner source validation, active-member recipient validation and no grants on source wardrobe tables. Implement revisioned `create_share`/recipient grant operations and RLS/read RPCs for selected payload snapshots only.
- [ ] **P9.01-T3** Build source Share actions and exact payload/recipient confirmation. Copy only included media into share-specific assets through durable jobs; publish ready share atomically after all required copies validate, with retry/cancel cleanup for unpublished copies.
- [ ] **P9.01-T4** Authorize media by active share + specific recipient grant + asset attachment. Fix URLs to short lifetime, no-store; source edits cannot silently expand the shared snapshot. Finalize minimal directory projection for selecting active friends without emails/private settings.

Acceptance:

1. **P9.01-A1 — E2E/DB:** Share requires explicit recipient and payload confirmation; fit photo is absent unless separately selected. No profile/selfie/private note/paid item price leaks through nested JSON or image metadata.
2. **P9.01-A2 — DB/integration:** A recipient can read selected snapshot/media only, never sharer's item tables/original images/other logs. Nonrecipient, pending, suspended and owner-admin-without-grant are denied.
3. **P9.01-A3 — Integration:** Failed media copy or canceled/stale source leaves no partially published share; retries create one share and clean unused copies. Foreign source/recipient forgery is rejected.
4. **P9.01-A4 — E2E:** Preview matches recipient-visible payload byte/field scope; source changes afterward do not silently share new fields or images.

## P9.02 — Read a finite “Shared with me” feed safely

**Depends on:** P9.01.  
**Demo:** A recipient opens Flock, sees only authorized shares, opens a deep link and returns; an unauthorized viewer sees a neutral unavailable state.

Tasks:

- [ ] **P9.02-T1** Build `/friends` Shared with me/My shares and `/friends/shares/:id`, with stable pagination, text/image alternatives and optional minimal unread state. Use authorized snapshot projections, not joins exposing full source objects.
- [ ] **P9.02-T2** Implement owner management and recipient detail reads with no existence/title/thumbnail leakage in errors, metadata or link previews. Do not generate public previews or public cache entries.
- [ ] **P9.02-T3** Handle expired share image authorization with refresh-once and neutral failure; clear recipient caches on logout, grant change and account switch. No view/sort action sends a message or changes a wear record.

Acceptance:

1. **P9.02-A1 — DB/E2E:** Sharer, two recipients and outsider fixture each see exactly their authorized sets; pagination has stable results and recipient cannot enumerate unrelated source IDs.
2. **P9.02-A2 — E2E/integration:** Guessed/deleted/revoked share URL has neutral unavailable copy with no source title, thumbnail or private Open Graph metadata.
3. **P9.02-A3 — Device/accessibility:** Feed/detail work with text alternatives, keyboard/VoiceOver/TalkBack and restored Back position; no swipe-only or image-only task.
4. **P9.02-A4 — Integration:** User/grant changes discard stale responses and cached private share media; analytics uses route templates and safe counts, never recipients' comments or payloads.

## P9.03 — Ask a private poll and accept two friends' votes

**Depends on:** P9.01–P9.02.  
**Demo:** Publish Rate my fit, A or B, or Ask before buying with a close time; two chosen friends vote/comment, one changes a vote, then the poll closes.

Tasks:

- [ ] **P9.03-T1** Add typed poll schemas, stable option IDs/text labels, server closing time and unique poll/member response. Define one vote per authorized recipient, editable while open; author may inspect results but is not counted as a recipient vote by default. Keep comments bounded plain text with edit/delete ownership.
- [ ] **P9.03-T2** Implement transactional create/respond/update/remove operations checking active grant and server time under locks; rating options and A/B choices are explicit, not free-form schema. Idempotency prevents duplicate responses/events.
- [ ] **P9.03-T3** Build three poll composer modes using the same payload preview/recipient confirmation, equal-sized A/B options, accessible labels, open/closed states, comments and results. Ask before buying shares selected verdict evidence, never completes a purchase.
- [ ] **P9.03-T4** Apply safe rendering and retention/deletion to comments/responses; no automatic public ranking or external message distribution. Clarify result scope as responses from selected friends.

Acceptance:

1. **P9.03-A1 — DB/integration:** Two authorized friends create two responses; changing one vote changes that row rather than adding another. Repeated request cannot inflate counts; nonrecipient/foreign poll/invalid option is rejected.
2. **P9.03-A2 — Integration:** Race vote with `closes_at` using server clock and with grant revocation: only still-open authorized changes commit. Device clock manipulation cannot reopen a poll.
3. **P9.03-A3 — E2E:** All three poll types show correct choices/results/closing time; A/B text alternatives are equivalent, comments render safely and no poll action records wear or purchase.
4. **P9.03-A4 — Human/device:** One real pilot poll receives votes from two chosen friends; record results without exporting their private comments/photos into repository evidence.

## P9.04 — Revoke, delete and verify the social boundary

**Depends on:** P9.01–P9.03.  
**Demo:** Revoke one recipient, keep access for another, then unshare/delete the source and verify no new access to any derived share or photo.

Tasks:

- [ ] **P9.04-T1** Implement recipient revocation and complete unshare with immediate authorization denial and cache invalidation. A single revoked recipient's previously signed URL may survive its short expiry; do not delete media still granted to others. Full unshare/deletion removes share copies and blocks future signing.
- [ ] **P9.04-T2** Extend source item/outfit/log/photo/wishlist and account deletion to scrub/revoke derived snapshots/assets, comments/votes as appropriate, pending copy jobs and caches. Removing a privately retained fit photo also removes copies shared from that photo.
- [ ] **P9.04-T3** Define minimal closed/deleted placeholders, audit facts and response lifecycle on member deletion; no personally linked vote/comment remains after account deletion unless an explicitly justified non-identifying aggregate is required. Replay social deletion journal on isolated restore.
- [ ] **P9.04-T4** Run full SOCIAL access matrix and recipient media expiry checks across web/native; expose truthful limitations about already seen/saved screenshots and pending physical deletion. Rehearse social flag disable and rollback without exposing source data.

Acceptance:

1. **P9.04-A1 — Integration/staging:** Revocation denies new feed/detail/media/poll access immediately; already issued URL ceases by its documented expiry or deletion. Other authorized recipients retain valid access until full unshare.
2. **P9.04-A2 — Integration:** Delete source or remove retained fit photo while share-copy job completes: no share can revive; source-derived attributes and all required copies are scrubbed. Storage outage stays pending/denied.
3. **P9.04-A3 — Staging:** Restore a pre-revocation/deletion backup in isolation, replay journal and invalidate sessions/capabilities: revoked/deleted shares and responses do not become available again.
4. **P9.04-A4 — E2E/device:** Unauthorized unavailable state has no old title/image, account switch clears cached shares, owner role confers no recipient bypass, and social disabling preserves private wardrobe/log operation.

## Phase exit and rollback

- [ ] A real poll has two friends' votes; all three poll types, comments and close-time behavior pass.
- [ ] Recipient grants never expose the underlying wardrobe/profile; source deletion and revocation work through storage and restore.
- [ ] Privacy preview and short-lived-link limitations are understandable on web and native.

Disable creation/reading of social payloads through the server feature gate during an authorization incident and stop further signing; keep revocation/deletion jobs running. Roll back compatible UI/API artifacts without broadening RLS. Private wardrobes, saved outfits and confirmed wear history remain independent.
