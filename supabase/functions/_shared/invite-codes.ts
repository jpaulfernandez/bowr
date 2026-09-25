// Invite codes: 128 random bits as 26 Crockford base32 characters. Only an HMAC
// digest is stored; the plaintext is returned to the owner once.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 26;

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function generateInviteCode(): string {
  const raw = encodeBase32(crypto.getRandomValues(new Uint8Array(16))).slice(0, CODE_LENGTH);
  return [raw.slice(0, 6), ...raw.slice(6).match(/.{5}/g)!].join('-');
}

/** Canonical form for digesting: case, spaces, dashes and look-alike letters ignored. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [
      'sign',
    ],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function inviteSecret(): string {
  const secret = Deno.env.get('INVITE_HMAC_SECRET');
  if (!secret || secret.length < 32) throw new Error('INVITE_HMAC_SECRET is not configured');
  return secret;
}

export const inviteDigest = (code: string) => hmacHex(inviteSecret(), `invite:${normalizeInviteCode(code)}`);

/**
 * Keyed hash of the client IP for throttling; raw addresses are never stored.
 * Prefers the edge-set cf-connecting-ip. Otherwise uses the last X-Forwarded-For
 * entry, which the nearest proxy appends; earlier entries are client-controlled.
 */
export async function clientIpHash(req: Request): Promise<string | null> {
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return ip ? await hmacHex(inviteSecret(), `ip:${ip}`) : null;
}
