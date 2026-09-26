// Operator-only encrypted database export (docs/runbooks/backup-restore.md).
//
//   DATABASE_URL=postgresql://... BACKUP_ENCRYPTION_KEY=<base64 32 bytes> BACKUP_DIR=/secure/path \
//   pnpm ops:backup-db
//
// Exports the auth, public and private schemas (schema and data) in pg_dump's
// custom format, encrypts it with AES-256-GCM, writes a manifest without secrets,
// and deletes this directory's backups older than seven days. Photos are not in
// the database and are not part of this backup.
// PG_TOOLS_CONTAINER runs pg_dump inside that container instead (local stack:
// supabase_db_bowr), for when the host's pg_dump is older than the server.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RETENTION_DAYS = 7;
const SCHEMAS = ['auth', 'public', 'private'];

const databaseUrl = process.env.DATABASE_URL;
const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY ?? '', 'base64');
const dir = process.env.BACKUP_DIR;
if (!databaseUrl || key.length !== 32 || !dir) {
  console.error('DATABASE_URL, BACKUP_DIR and a base64 32-byte BACKUP_ENCRYPTION_KEY are required.');
  process.exit(2);
}

const schemaArgs = SCHEMAS.flatMap((schema) => ['--schema', schema]);
const container = process.env.PG_TOOLS_CONTAINER;
const dump = container
  ? spawnSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', new URL(databaseUrl).pathname.slice(1), '-Fc', ...schemaArgs], {
      maxBuffer: 1024 * 1024 * 1024,
    })
  : spawnSync('pg_dump', [`--dbname=${databaseUrl}`, '-Fc', ...schemaArgs], { maxBuffer: 1024 * 1024 * 1024 });
if (dump.status !== 0) {
  console.error(`pg_dump failed: ${dump.stderr.toString().slice(0, 500)}`);
  process.exit(1);
}

const createdAt = new Date();
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(dump.stdout), cipher.final()]);
const payload = Buffer.concat([Buffer.from('BOWRBK1'), iv, cipher.getAuthTag(), encrypted]);

mkdirSync(dir, { recursive: true, mode: 0o700 });
const name = `bowr-${createdAt.toISOString().replace(/[:.]/g, '-')}`;
const file = join(dir, `${name}.dump.enc`);
writeFileSync(file, payload, { mode: 0o600 });
const manifest = {
  created_at: createdAt.toISOString(),
  file: `${name}.dump.enc`,
  sha256: createHash('sha256').update(payload).digest('hex'),
  bytes: payload.length,
  schemas: SCHEMAS,
  format: 'pg_dump custom, AES-256-GCM (BOWRBK1 | iv | tag | ciphertext)',
};
writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

// Seven-day rolling retention in this location.
let removed = 0;
for (const entry of readdirSync(dir).filter((f) => f.startsWith('bowr-') && f.endsWith('.json'))) {
  const old = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
  if (Date.parse(old.created_at) < createdAt.getTime() - RETENTION_DAYS * 86_400_000) {
    rmSync(join(dir, old.file), { force: true });
    rmSync(join(dir, entry), { force: true });
    removed += 1;
  }
}
console.log(JSON.stringify({ backup: join(dir, `${name}.json`), bytes: payload.length, expired_removed: removed }));
