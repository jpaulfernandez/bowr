// Minimal container checks for worker output. The Edge publishes dimensions read
// from the bytes themselves, never the dimensions a worker claims.
export type ImageInfo = { contentType: 'image/webp' | 'image/png'; width: number; height: number };

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

function webpInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X') {
    return { contentType: 'image/webp', width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      contentType: 'image/webp',
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { contentType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function pngInfo(bytes: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, i) => bytes[i] !== value) || ascii(bytes, 12, 16) !== 'IHDR') {
    return null;
  }
  return { contentType: 'image/png', width: be32(bytes, 16), height: be32(bytes, 20) };
}

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  return webpInfo(bytes) ?? pngInfo(bytes);
}
