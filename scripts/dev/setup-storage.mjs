// Creates the private bucket and applies exact-origin CORS. Works against the local
// gateway and against R2 (S3 API). Usage:
//   R2_PUBLIC_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... APP_ORIGINS=... \
//   node scripts/dev/setup-storage.mjs
// Defaults read supabase/functions/.env (local values only).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';

const envFile = new URL('../../supabase/functions/.env', import.meta.url);
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
  : {};
const env = (name) => process.env[name] ?? fileEnv[name];

const endpoint = env('R2_PUBLIC_ENDPOINT').replace(/\/$/, '');
const bucket = env('R2_BUCKET');
const origins = env('APP_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean);
const aws = new AwsClient({ accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY'), service: 's3', region: 'auto' });

const created = await aws.fetch(`${endpoint}/${bucket}`, { method: 'PUT' });
if (!created.ok && created.status !== 409) throw new Error(`bucket create failed: ${created.status} ${await created.text()}`);

// Browsers may only PUT a signed upload and GET a signed view from these origins.
const cors = `<CORSConfiguration><CORSRule>${origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>content-type</AllowedHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
const corsResponse = await aws.fetch(`${endpoint}/${bucket}?cors`, {
  method: 'PUT',
  body: cors,
  headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(cors).digest('base64') },
});
if (!corsResponse.ok) throw new Error(`CORS configuration failed: ${corsResponse.status} ${await corsResponse.text()}`);
console.log(`Bucket ${bucket} ready at ${endpoint} with CORS for ${origins.join(', ')}`);
