# bowr

Private wardrobe, outfit planning, and fit logging.

- [Product requirements](<bowr — PRD.md>)
- [Product context](PRODUCT.md)
- [Design specification](DESIGN.md)
- [System architecture](ARCHITECTURE.md)
- [Implementation plan and phase breakdown](docs/implementation/README.md)

## Local development

Prerequisites: Node 22 (`.nvmrc`), pnpm 10, [uv](https://docs.astral.sh/uv/), and Docker.

```sh
pnpm install
(cd services/worker && uv sync)
pnpm worker:models           # pinned cutout weights (checksums in config/models.yaml)

# Local Supabase: Postgres, Auth, Edge runtime and Mailpit for sign-in emails.
cp supabase/functions/.env.example supabase/functions/.env
pnpm db:start
pnpm storage:start           # S3-compatible stand-in for the private R2 bucket
pnpm worker:serve            # photo validation worker (keep running in another terminal)
pnpm fake-ai:serve           # deterministic Gemini stand-in; no paid calls locally

# Web client configuration: public values only.
cp apps/app/.env.example apps/app/.env.local
# Set EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY from `pnpm exec supabase status`.

pnpm --filter @bowr/app web   # dev server on http://localhost:8081
```

Sign-in emails arrive in Mailpit at http://127.0.0.1:54324. A new account is pending until it is admitted. Make the first account the owner with the operator command:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm ops:bootstrap-owner --user-id <auth-user-uuid>
```

The web session lives in the browser tab (`sessionStorage`); closing the tab signs you out.

See [AGENTS.md](AGENTS.md#commands) for the test, lint and build commands.
