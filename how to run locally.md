# How to run locally

You can run the full **local version** using the setup below. Local email goes to Mailpit; local AI uses a fake provider and incurs no Gemini charges.

## 1. First-time setup

Start Docker Desktop, then run:

```bash
cd /Users/polaris/projects/bowr

nvm install 22
nvm use 22

pnpm install --frozen-lockfile
(cd services/worker && uv sync --frozen)
pnpm worker:models

cp -n supabase/functions/.env.example supabase/functions/.env
cp -n apps/app/.env.example apps/app/.env.local

pnpm db:start
pnpm storage:start
pnpm exec supabase status
```

Copy the local **publishable key** from the last command into `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in [`apps/app/.env.local`](apps/app/.env.local). Keep its Supabase URL pointed at `127.0.0.1`, not your hosted project.

## 2. Keep these running in three separate terminals

Run each from the repository root:

| Terminal | Purpose | Command |
| --- | --- | --- |
| Worker | Validates photos and creates cutouts | `pnpm worker:serve` |
| Fake AI | Tests processing without paid calls | `pnpm fake-ai:serve` |
| App | Runs the web app | `pnpm --filter @bowr/app web` |

Open [the app](http://localhost:8081). Sign in using an email address, then open [Mailpit](http://127.0.0.1:54324) to retrieve its sign-in link.

## 3. Make your first account the owner

After signing in, your account will initially be pending. Find its UUID:

```bash
docker exec supabase_db_bowr psql -U postgres -d postgres \
  -c "select id, email from auth.users;"
```

Then replace `<your-user-uuid>` below:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm ops:bootstrap-owner --user-id <your-user-uuid>
```

Refresh the app. This bootstrap works once.

## What to test in Phase 00: access and reliability

| Try this | Expected result |
| --- | --- |
| Sign in, refresh, sign out | Your session and navigation behave correctly; private pages require sign-in. |
| Create an invite in `/admin`; redeem with a second account | The second account becomes a member. Reusing the invite fails. |
| Switch between two accounts | Neither sees the other’s wardrobe or images. |
| Upload a photo, then reload while processing | Uploaded work remains available and does not create duplicate pieces. |
| Set AI allowance to zero in Admin | Manual uploads and edits still work. |
| Suspend and restore the second member | Access is blocked while suspended and restored afterward. |
| Delete a disposable test piece/account | Access stops; unfinished cleanup is shown as pending. |

Actual object deletion, concurrency and restore guarantees also require automated/backend checks; the UI alone cannot prove them.

## What to test in Phase 01: your wardrobe

| Try this | Expected result |
| --- | --- |
| Gather a shirt, dress, shoes and accessory | Each becomes a piece with an original and cutout, or a clear recovery action. |
| Edit name, category and colors; reload | Your changes persist. |
| Upload several photos, including an invalid file | Successful files survive; the failed file can be retried separately. |
| Attach a care-label photo | It belongs to the selected garment and does not become another piece. |
| Upload the same photo twice | Duplicate review offers the appropriate choices. |
| Split a grouped accessory photo | Only explicitly confirmed parts become pieces. |
| Repair a cutout or replace its photo | The piece keeps its identity and your metadata. |
| Search, filter, bulk-edit, archive and restore | Results and counts reflect your actions. |
| Repeat with AI allowance at zero | Manual wardrobe workflows remain usable. |

## Local limitations

Fake AI tags do not demonstrate real tagging accuracy, and the current development embeddings do not demonstrate semantic matching. The 20-piece model comparison and 50-piece owner pilot remain open. Outfit planning and wear logging belong to **Phase 02**.

For a first session, start with **five pieces and two accounts**, then test upload → edit → find → archive/restore → delete.
