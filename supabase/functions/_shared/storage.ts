// Private object storage (Cloudflare R2 in staging/production; an S3-compatible
// gateway locally). Signed URLs are bearer capabilities: never log or persist them.
import { AwsClient } from 'npm:aws4fetch@1.0.20';

type StorageConfig = { client: AwsClient; bucket: string; publicEndpoint: string; internalEndpoint: string };

let config: StorageConfig | null = null;

function storage(): StorageConfig {
  if (config) return config;
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  const bucket = Deno.env.get('R2_BUCKET');
  const publicEndpoint = Deno.env.get('R2_PUBLIC_ENDPOINT');
  if (!accessKeyId || !secretAccessKey || !bucket || !publicEndpoint) throw new Error('Storage is not configured');
  config = {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    bucket,
    // Browsers and the worker use the public endpoint; the Edge runtime may reach
    // the same store through a different network address.
    publicEndpoint: publicEndpoint.replace(/\/$/, ''),
    internalEndpoint: (Deno.env.get('R2_INTERNAL_ENDPOINT') ?? publicEndpoint).replace(/\/$/, ''),
  };
  return config;
}

export const bucketName = () => storage().bucket;

function objectUrl(
  endpoint: string,
  key: string,
  query: Record<string, string> = {},
  bucket = storage().bucket,
): string {
  const url = new URL(`${endpoint}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

/** Signed PUT for one exact key; the Content-Type is part of the signature. */
export async function presignPut(key: string, contentType: string, seconds: number): Promise<string> {
  const { client, publicEndpoint } = storage();
  const signed = await client.sign(
    objectUrl(publicEndpoint, key, { 'X-Amz-Expires': String(Math.max(1, Math.floor(seconds))) }),
    {
      method: 'PUT',
      headers: { 'content-type': contentType },
      aws: { signQuery: true, allHeaders: true },
    },
  );
  return signed.url;
}

/** Signed GET that tells browsers not to store the private response. */
export async function presignGet(key: string, seconds: number): Promise<string> {
  const { client, publicEndpoint } = storage();
  const signed = await client.sign(
    objectUrl(publicEndpoint, key, {
      'X-Amz-Expires': String(Math.max(1, Math.floor(seconds))),
      'response-cache-control': 'private, no-store',
    }),
    { method: 'GET', aws: { signQuery: true } },
  );
  return signed.url;
}

export async function headObject(key: string): Promise<{ size: number } | null> {
  const { client, internalEndpoint } = storage();
  const response = await client.fetch(objectUrl(internalEndpoint, key), { method: 'HEAD' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage HEAD ${response.status}`);
  return { size: Number(response.headers.get('content-length') ?? '0') };
}

export async function getObject(key: string, maxBytes: number): Promise<Uint8Array | null> {
  const { client, internalEndpoint } = storage();
  const response = await client.fetch(objectUrl(internalEndpoint, key), { method: 'GET' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage GET ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('storage object too large');
  return bytes;
}

/** Idempotent delete followed by an existence check. */
export async function deleteObject(key: string): Promise<boolean> {
  const { client, internalEndpoint } = storage();
  const response = await client.fetch(objectUrl(internalEndpoint, key), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`storage DELETE ${response.status}`);
  return (await headObject(key)) === null;
}

const xmlText = (value: string) =>
  value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(
    /&amp;/g,
    '&',
  );

/** Every key in the private bucket with its last-modified time (ListObjectsV2). */
export async function listObjects(): Promise<Array<{ key: string; lastModified: number }>> {
  const { client, internalEndpoint, bucket } = storage();
  const objects: Array<{ key: string; lastModified: number }> = [];
  let token: string | null = null;
  do {
    const url = new URL(`${internalEndpoint}/${bucket}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('max-keys', '1000');
    if (token) url.searchParams.set('continuation-token', token);
    const response = await client.fetch(url.toString(), { method: 'GET' });
    if (!response.ok) throw new Error(`storage LIST ${response.status}`);
    const body = await response.text();
    for (const [, contents] of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(contents!)?.[1];
      const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(contents!)?.[1];
      if (key && modified) objects.push({ key: xmlText(key), lastModified: Date.parse(modified) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(body)
      ? xmlText(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1] ?? '') || null
      : null;
  } while (token);
  return objects;
}

/**
 * Writes one entry to the deletion journal bucket, which lives outside the
 * database's backup timeline (ARCHITECTURE 14.4). Holds pseudonymous IDs only.
 */
export async function putJournalEntry(key: string, body: string): Promise<void> {
  const bucket = Deno.env.get('DELETION_JOURNAL_BUCKET');
  if (!bucket) throw new Error('Deletion journal is not configured');
  const { client, internalEndpoint } = storage();
  const response = await client.fetch(objectUrl(internalEndpoint, key, {}, bucket), {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error(`journal PUT ${response.status}`);
}
