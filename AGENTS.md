# AGENTS.md

Instructions for coding agents working in this repository. Behavioral guidelines in the second half are adapted from [Andrej Karpathy's observations on LLM coding pitfalls](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md).

## Project

bowr is a private wardrobe, outfit-planning and fit-logging app for an owner and 2–10 invited friends. Members Gather photos of owned clothing into a Bower, Arrange outfits from real owned pieces, and Strut (confirm) what they wore.

**Current state:** specifications only. No application code, migrations, worker, or test harness exists yet. Do not claim that commands, files, or tests exist until you have created them.

## Source documents

Read the relevant sections before changing behavior. Do not load every document for a small task.

| Document | Authority |
| --- | --- |
| [bowr — PRD.md](<bowr — PRD.md>) | Feature scope (F1–F10), roadmap, pilot outcomes, US$10 shared AI ceiling |
| [PRODUCT.md](PRODUCT.md) | Users, purpose, brand, accessibility, privacy constraints |
| [DESIGN.md](DESIGN.md) | Routes, interactions, tokens, recovery states, resolved PRD ambiguities |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, schemas, APIs, invariants, security, operations |
| [docs/implementation/](docs/implementation/README.md) | Phase files, slice IDs, acceptance cases, test strategy |

Precedence: the PRD sets scope; DESIGN refines interaction and measurement; ARCHITECTURE refines technical and security behavior. If documents conflict and none resolves it, stop and ask. Record the decision rather than guessing in code.

## Stack and layout

Expo + React Native + react-native-web (TypeScript strict), Expo Router, NativeWind, TanStack Query, React Hook Form + Zod, Supabase (Postgres, pgvector, RLS, Edge Functions), Cloudflare R2, Python 3.12 worker on Modal, Gemini via one budget-gated gateway. Tooling: pnpm, uv, Supabase CLI. Tests: Vitest, pgTAP, pytest, Playwright + axe.

Planned locations (ARCHITECTURE §3.2): `apps/app/`, `packages/{contracts,domain,design-tokens}/`, `supabase/{migrations,functions,tests}/`, `services/worker/`, `config/`, `tests/e2e/`, `docs/runbooks/`, `docs/implementation/evidence/`.

Dependency direction is one-way: app and Edge code depend on contracts/domain; shared packages never import screens or provider clients; Python consumes generated JSON contracts, not TypeScript source.

## Invariants

Never violate these (ARCHITECTURE §1.1):

1. Login without active membership cannot reach wardrobe data or private media.
2. Members access only their own records. Admin does not grant wardrobe access.
3. Model output is untrusted. It cannot authorize access, create a wear, or add an unowned item to an outfit.
4. User edits override inference, including results that arrive later.
5. Save, rate, love, and log are distinct operations.
6. A confirmed fit and all its wear records commit together, once per request identity.
7. Permanent deletion removes private assets and reusable item details from snapshots and derived results.
8. Manual wardrobe, outfit, and logging workflows work with AI unavailable.
9. Database and object-storage changes are not one transaction; every cross-service workflow reconciles partial completion.

Also: every billable AI call goes through the reservation gateway; no secrets, private photos, signed URLs, measurements, invite codes, or provider payloads in commits or evidence; UI is light-only and targets WCAG 2.2 AA with no camera/swipe/drag-only critical path.

## How to work

Build in vertical slices as described in [docs/implementation/README.md](docs/implementation/README.md). Take the next slice whose dependencies have passed, create only what that slice needs, and do not prebuild later-phase tables or placeholder screens. Keep slice IDs (`P1.02`, `P1.02-T1`, `P1.02-A1`) stable in commits, issues and evidence.

These guidelines favor caution over speed. For trivial tasks, use judgment.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. If uncertain, ask.
- If a request has several interpretations, present them instead of picking one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what is confusing, and ask.

### 2. Simplicity first

Write the minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked or what the current slice requires.
- No abstractions for single-use code. Add a seam only when a delivering slice needs it.
- No unrequested flexibility or configurability.
- No error handling for impossible scenarios. Do handle the failure cases the slice specifies.
- If 200 lines could be 50, rewrite it.

Ask: would a senior engineer call this overcomplicated? If yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Match existing style, even if you would do it differently.
- Mention unrelated dead code; don't delete it.
- Remove imports, variables, and functions that your change made unused. Leave pre-existing dead code unless asked.

Every changed line should trace directly to the request.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

Turn tasks into verifiable goals:

- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

A slice is done only when its acceptance cases pass against the real local stack, unauthorized access is proven blocked, and evidence is recorded (see the definition of done in [docs/implementation/README.md](docs/implementation/README.md) and [test-strategy.md](docs/implementation/test-strategy.md)). A UI success message is not proof. Sequential tests do not prove concurrency. Report failures and skipped checks plainly.

## Commands

None yet. Phase 0 (P0.01) scaffolds the repository and must record the actual lint, type-check, test, migration-reset, and build commands here once they exist.
