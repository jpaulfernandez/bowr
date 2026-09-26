// Short-lived, job-scoped capabilities for the worker. They authorize exactly one
// job, lease generation and set of output keys; they are not user credentials.
export type JobCapability = {
  job_id: string;
  user_id: string;
  /** Validation: the upload's asset. Item stages: the item. */
  target_id: string;
  stage: 'validate_upload' | 'crop' | 'cutout' | 'colors' | 'embedding' | 'tags' | 'label';
  lease_generation: number;
  /** Rendition name -> server-chosen object key. */
  output_keys: Record<string, string>;
  exp: number;
};

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function key(): Promise<CryptoKey> {
  const secret = Deno.env.get('WORKER_CAPABILITY_SECRET');
  if (!secret || secret.length < 32) throw new Error('WORKER_CAPABILITY_SECRET is not configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signCapability(payload: JobCapability): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await key(), encoder.encode(`bowr.job.v1.${body}`)),
  );
  return `${body}.${base64url(signature)}`;
}

export async function verifyCapability(token: string | undefined): Promise<JobCapability | null> {
  if (!token) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await key(),
      fromBase64url(signature),
      encoder.encode(`bowr.job.v1.${body}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as JobCapability;
    return payload.exp * 1000 > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
