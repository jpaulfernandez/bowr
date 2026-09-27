-- Local development only (runs on `supabase db reset`). Staging and production
-- configure these Vault secrets with real values; see docs/runbooks/environments.md.
select vault.create_secret(
  'http://supabase_kong_bowr:8000/functions/v1/maintenance',
  'bowr_maintenance_url',
  'Maintenance Edge function URL reachable from the database'
);
select vault.create_secret(
  'local-only-maintenance-secret-0123456789abcdef',
  'bowr_maintenance_secret',
  'Machine secret for scheduled maintenance calls'
);

-- Local vector space: the deterministic development embedding in the local
-- worker (services/worker/src/bowr_worker/embedding.py). It is not semantic and
-- never enabled in staging/production, which set their space when FashionCLIP
-- passes its gate (docs/runbooks/environments.md).
insert into private.embedding_space (model, model_revision, preprocess_version, dimension)
values ('bowr_dev_embed', 'v1', 'cutout-on-grey-64', 512);
