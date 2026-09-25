# Phase 8 — Native iOS and Android

**Outcome:** Friends install the shared app, capture with guides, send product links into Shinies, and opt into reminders at their chosen local time.  
**Depends on:** [Phase 7](phase-07-friend-onboarding.md); phase-4 wishlist and existing API contracts.  
**Sources:** [PRD mobile/web and phase 8](<../../bowr — PRD.md>); [DESIGN §§7, 10, 12](../../DESIGN.md); [ARCHITECTURE §§3–4, 13–14](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-09-flock.md).

## Entry and scope

Use the Expo application and server contracts already shipped. Verify current EAS/runtime/plugin compatibility and actual store prerequisites before choosing versions. Native requires device testing; it is more than exporting an unchanged web build. No full offline mutation sync or new backend per platform.

## P8.01 — Install, sign in and use the private core loop natively

**Depends on:** P7.03 and owner-controlled distribution setup.  
**Demo:** Install an internal iOS/Android build, redeem/sign in, open a deep link and complete manual outfit/log actions with the same private data as web.

Tasks:

- [ ] **P8.01-T1** Configure bundle/package identifiers, signing, EAS build/update channels and runtime versions, staging/production public configuration and store testing groups. Record current fees/plans separately from AI spend; keep secrets server-side.
- [ ] **P8.01-T2** Implement secure-store session adapter, OAuth/magic-link native callbacks, allowed deep links, foreground/background query lifecycle and memory-only private image behavior. Clear sessions/caches on sign out, expiry and account switch.
- [ ] **P8.01-T3** Add native PostHog allowlist adapter, accessible navigation/safe areas/platform controls and contract-compatible error recovery. Test TalkBack/VoiceOver, Dynamic Type/font scaling and reduce motion.
- [ ] **P8.01-T4** Distribute release candidates through TestFlight and Play internal testing; verify web remains compatible with the same additive API/schema version and shared account data.

Acceptance:

1. **P8.01-A1 — Device/staging:** At least one real iOS and Android device installs, completes auth/deep-link return, accesses only its account, and runs Gather/manual outfit/Strut history flows against the shared service.
2. **P8.01-A2 — Device/integration:** Background/kill/reopen and account switch cannot expose previous private data or replay writes; expired/foreign deep links fail safely. Secure storage and bundle inspection reveal no provider secrets.
3. **P8.01-A3 — Device:** VoiceOver/TalkBack, font scaling, focus, reduced motion and keyboard where available support critical tasks; web release candidate retains parity.
4. **P8.01-A4 — Integration:** Native analytics contains the same approved event fields, no automatic private screens/URLs/recordings, and failure does not block product use.

## P8.02 — Capture with category guides and repair photos on device

**Depends on:** P8.01 and phase-1 capture/media editor contracts.  
**Demo:** Take a shoe side-view photo with framing guidance, upload it, adjust its cutout or replace it, and finish through gallery if camera permission is denied.

Tasks:

- [ ] **P8.02-T1** Implement `expo-camera` native capture with hanger/flat-lay/shoe category framing outlines and the existing accessory guide content. Request permission only from explicit camera action; gallery/manual choices remain available.
- [ ] **P8.02-T2** Normalize orientation/rotation and camera metadata through the same server validation; test actual HEIC/large-phone images against advertised limits. Preserve unsent/uploaded distinction during app suspension.
- [ ] **P8.02-T3** Implement native mask-editor adapter with restore/erase/zoom/undo/reset or equivalent explicit controls; retain original/retry/replace alternatives. All resulting masks use the existing validated media revision contract.

Acceptance:

1. **P8.02-A1 — Device/worker:** Actual iOS/Android captures orient correctly and produce sanitized private assets; denied/restricted camera access reaches gallery without losing draft.
2. **P8.02-A2 — Device/integration:** Background/kill during upload does not claim unsent files are safe or create duplicate pieces. Already uploaded processing resumes by server identity.
3. **P8.02-A3 — Device/E2E:** Guides change by chosen category, accessories remain first-class, and repair/reshoot preserves item ID/metadata. Stale mask result cannot replace a newer photo.
4. **P8.02-A4 — Accessibility:** Framing/gesture tools have text and explicit alternatives; a user can successfully add/repair through non-camera/non-drawing paths.

## P8.03 — Share a product link into Shinies

**Depends on:** P8.01 and P4.01–P4.02.  
**Demo:** From Safari share a Uniqlo link to bowr, authenticate if needed, review the imported candidate and save it once; repeat on Android's share sheet.

Tasks:

- [ ] **P8.03-T1** Choose and pin a currently compatible Expo share-intent plugin/extension, implement URL payload validation and bridge into the existing wishlist import route. Do not build a separate preview/extraction stack.
- [ ] **P8.03-T2** Define bounded pending-share lifetime and single import identity across extension/app launches. Hold only necessary URL metadata privately until auth/admission succeeds; clear it on cancel/account switch/expiry and never put it in analytics/deep-link logs.
- [ ] **P8.03-T3** Show review before saving/extraction commitments where required by the existing flow; blocked preview uses screenshot/manual entry. Handle unsupported text, multiple links and explicit cancel with clear outcomes.

Acceptance:

1. **P8.03-A1 — Device:** Safari→bowr Uniqlo share lands on the correct editable wishlist input; Android browser share does likewise. Signed-out/pending user completes the proper gate before private processing.
2. **P8.03-A2 — Integration/device:** Duplicate intent delivery/extension restart uses one import identity and creates no duplicate candidate or paid request. A new deliberate share can be reviewed separately.
3. **P8.03-A3 — Security/E2E:** Malformed/private-network URLs go through the same server defenses; no bypass through native input. Account switch cannot attach a stale intent to the wrong member without review.
4. **P8.03-A4 — Device:** Store block, denied extension access and canceled import have working paste/screenshot/manual fallbacks; retained pending metadata obeys its expiry.

## P8.04 — Opt into a reminder and ship a reversible native release

**Depends on:** P8.01–P8.03.  
**Demo:** A friend chooses a local reminder time, receives a generic reminder, opens a new fit draft, then disables reminders and receives no further scheduled notification.

Tasks:

- [ ] **P8.04-T1** Add owner-scoped device installations, token rotation/revocation and reminder preferences/timezone. Reminders start off; offer after demonstrated use and request OS permission only after a deliberate opt-in/time choice.
- [ ] **P8.04-T2** Implement bounded server scheduling/delivery with unique installation/local-date reminder identity, server-time eligibility, timezone/DST behavior, receipts and invalid-token cleanup. A notification links to the log flow; it never confirms a wear. Generic lock-screen content contains no garment/photo/private notes.
- [ ] **P8.04-T3** Provide edit/disable and denied-permission recovery without repeated prompts. Sign out, account deletion, suspension and preference disable cancel/revoke future delivery; already handed-off notifications are described honestly.
- [ ] **P8.04-T4** Verify EAS Update runtime compatibility and rollback channels, staged internal rollout and store binary fallback for native module changes. Record real install/camera/share/push acceptance on both platforms and complete deletion-aware restore for new token records.

Acceptance:

1. **P8.04-A1 — Device/integration:** No reminder before explicit opt-in; one scheduled identity per chosen installation/date; double scheduler run cannot send another. Changed time/timezone and DST follow documented local-time semantics.
2. **P8.04-A2 — Device:** Tap notification opens an unconfirmed draft or auth gate, not a wear record; OS denial still permits manual logging. Disable/sign out/delete removes future eligibility and cleans tokens.
3. **P8.04-A3 — Integration:** Pending/suspended/foreign token registration fails; rotated invalid tokens retire; generic notification payload exposes no private media/details. Restoring old DB cannot reactivate deleted device tokens.
4. **P8.04-A4 — Device/release:** Friends install from TestFlight/Play, Safari and Android share tests pass, and a compatible OTA rollback works; native-module changes require a new binary instead of an incompatible OTA.

## Phase exit and rollback

- [ ] Actual iOS and Android install/auth/capture/share/reminder journeys pass, not just simulator builds.
- [ ] Notifications remain optional and default-off; share imports reuse safe/idempotent server behavior.
- [ ] Web works throughout distribution/review delays and native rollback is rehearsed.

Disable share extension admission or reminder delivery independently; retain paste/manual logging. Roll back compatible OTA updates within their runtime; ship a new binary for native fixes. Preserve user wardrobe/history and cancel invalid tokens rather than retrying indefinitely.
