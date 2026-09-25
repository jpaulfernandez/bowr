# Phase 7 — Validate onboarding with three friends

**Outcome:** Three friends independently establish private wardrobes and complete the core loop on their actual phone browsers.  
**Depends on:** Phases 0–6 in delivery order; foundational invitations already shipped in phase 0.  
**Sources:** [PRD phase 7 and success metrics](<../../bowr — PRD.md>); [DESIGN §§6.1, 13–14](../../DESIGN.md); [ARCHITECTURE §§5, 14–16](../../ARCHITECTURE.md).  
**Navigation:** [Plan](README.md) · [Tests](test-strategy.md) · [Next phase](phase-08-native-apps.md).

## Entry and scope

This phase improves and validates the existing private product; it does not introduce sharing or rebuild invitations. Start with observed friction. No referral program, public signup expansion or mandatory profile questionnaire.

## P7.01 — Join and create a useful starter wardrobe independently

**Depends on:** Existing production-like auth, invite and Gather flows.  
**Demo:** A first-time friend follows their invite, understands privacy, adds a small outfit's worth of pieces and saves or logs an outfit without facilitator instructions.

Tasks:

- [ ] **P7.01-T1** Prepare owner-created individual invitations and a neutral task script; the owner distributes codes through their chosen channel. Confirm real SMTP/OAuth behavior, expiry and used-code recovery; do not add automated messaging.
- [ ] **P7.01-T2** Refine onboarding using observed failures: feature name + plain subtitle, skip/explore, one-top/bottom-or-dress-plus-shoes guidance, category photo help, and upload interruption recovery. Measurements/taste/location remain optional later choices.
- [ ] **P7.01-T3** Verify shared-device sign-out/cache reset and that owner support sees only operational summaries. Resolve blocking bugs at existing responsible layers and add regression proof only where behavior needs it.

Acceptance:

1. **P7.01-A1 — Human/device:** Each of three friends independently signs in/redeems, reaches usable pieces and saves an outfit or confirms a log; record device/browser, task time and every assistance point.
2. **P7.01-A2 — Human:** Each can explain what is private, whether a fit photo was saved, and Save versus Wear. Blocking misunderstandings are fixed and retested.
3. **P7.01-A3 — DB/E2E:** Friend A cannot read B or owner data through any path; admin support cannot view friends' photos/profile. No social affordance implies automatic sharing.
4. **P7.01-A4 — Device:** Camera denial, failed file, session expiry and AI pause have usable recovery during onboarding; no 20-item minimum blocks first value.

## P7.02 — Measure activation and sustainable use truthfully

**Depends on:** P7.01 and existing allowlisted analytics.  
**Demo:** Owner sees aggregate activation and safe operational issues, while each friend can manually log during a shared AI pause.

Tasks:

- [ ] **P7.02-T1** Build/configure activation and retention views from allowed events: auth→invite→first ready piece→saved outfit/confirmed log, first 5/20 pieces, weekly active users, logged days and week-1/week-4 cohorts.
- [ ] **P7.02-T2** Define observation windows and eligible cohort denominators; show not-yet-observable retention instead of zero. Use optional self-reported wardrobe size for digitization; reactivation after 90 days needs prior logging coverage.
- [ ] **P7.02-T3** Review group correction/failure/resource/spend patterns without reading private content. Test concurrency at the 11-member/3,300-item planning envelope and document fair processing, paused AI and support recovery.

Acceptance:

1. **P7.02-A1 — Domain/integration:** Fixture events produce expected funnel/cohort counts with deduped events and UTC timestamps/local wear-date semantics; absent or immature data cannot become a success claim.
2. **P7.02-A2 — Integration:** Analytics payload audit has no emails, notes, exact measurements, private URLs or entered text. Analytics failure never prevents onboarding/logging.
3. **P7.02-A3 — Staging/device:** Concurrent member work obeys processing fairness and one shared budget, not separate monetary quotas. Paused-AI manual flow remains usable for all three friends.
4. **P7.02-A4 — Human:** Record first-three-month metric baseline and next observation date; phase completion does not require pretending four-week/90-day data already exists.

## P7.03 — Close pilot blockers and prepare native delivery

**Depends on:** P7.01–P7.02.  
**Demo:** Three separate wardrobes remain usable after fixes, and a native-readiness checklist identifies tested adapters and outstanding account/setup work.

Tasks:

- [ ] **P7.03-T1** Triage pilot failures by privacy/correctness, blocked core task and nonblocking polish. Resolve all blocking core/accessibility issues and rerun affected tasks; record remaining optional improvements separately.
- [ ] **P7.03-T2** Audit `.web`/`.native` seams, RN primitives, API version compatibility, private media caching and auth assumptions; identify concrete native adapter gaps without creating a second app architecture.
- [ ] **P7.03-T3** Prepare phase-8 account/distribution requirements and current fee/plan verification, identifying owner-controlled enrollment/signing prerequisites and review lead time. Do not treat fees/account approval as already completed or part of the AI allowance.
- [ ] **P7.03-T4** Refresh support, invite revoke versus member suspension, deletion, budget and restore runbooks after the pilot; retain web access throughout future store review.

Acceptance:

1. **P7.03-A1 — Human/release evidence:** Three real friends have independent private wardrobes; no remaining blocker prevents the core loop. Record concrete failures/fixes and participant outcomes.
2. **P7.03-A2 — Review/build:** Native gap list maps each adapter to P8 tasks; build/account prerequisites and latest verification dates are recorded. Web-only code cannot silently enter shared native paths.
3. **P7.03-A3 — Staging:** A representative account deletion and missed-cleanup recovery still work after pilot fixes; known operational issues have owners and reproducible steps.

## Phase exit and rollback

- [ ] Three friends pass the independent onboarding/core-loop protocol; privacy boundaries remain intact.
- [ ] Activation baselines use honest denominators and no invented long-term results.
- [ ] Phase-8 setup dependencies are concrete and tracked.

Roll back the specific onboarding change that regresses a flow, preserve existing accounts/wardrobes and stop issuing new invites if a blocking issue appears. Do not revoke existing members or delete pilot data as part of a UI rollback.
