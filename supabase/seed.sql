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
