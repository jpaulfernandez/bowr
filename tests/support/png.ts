import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

type Decoded = { width: number; height: number; channels: number; pixels: Buffer };
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decodes an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB or RGBA). */
export function decodePng(png: Buffer): Decoded {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let header: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = Buffer.from(data);
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG without IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = CHANNELS[header[9]!];
  if (header[8] !== 8 || !channels || header[12] !== 0) throw new Error('unsupported PNG');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predicted === undefined) throw new Error('bad PNG filter');
      pixels[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Encodes 8-bit pixels (1 channel: grey, 3: RGB, 4: RGBA) as a PNG. */
export function encodePng({ width, height, channels, pixels }: Decoded): Buffer {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  if (colorType === undefined) throw new Error('unsupported channels');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(filtered)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Returns a copy of an 8-bit RGB/RGBA PNG whose top-left corner encodes `n`
 * (512 values), so repeated test uploads are different photos (their sanitized
 * bytes differ) while the garment itself is untouched. Tests of exact reuploads
 * use the unmarked bytes.
 */
export function markPng(png: Buffer, n: number): Buffer {
  const image = decodePng(png);
  const { width, height, channels: bpp, pixels } = image;
  if (bpp < 3) throw new Error('unsupported PNG');
  const stride = width * bpp;
  // A 24 px corner block, shifted a few levels from the corner's own colour:
  // large enough to survive lossy WebP normalization, too faint to be a garment.
  const shift = (value: number, by: number) => Math.max(0, Math.min(255, value < 128 ? value + by : value - by));
  const colour = [shift(pixels[0]!, 3 * (n % 8) + 3), shift(pixels[1]!, 3 * ((n >> 3) % 8)), shift(pixels[2]!, 3 * ((n >> 6) % 8))];
  for (let y = 0; y < Math.min(24, height); y += 1) {
    for (let x = 0; x < Math.min(24, width); x += 1) {
      for (let c = 0; c < 3; c += 1) pixels[y * stride + x * bpp + c] = colour[c]!;
    }
  }
  return encodePng(image);
}

// Sequential within a test process, so one member's uploads never repeat a marker.
let counter = Math.floor(Math.random() * 512);
/** A fresh, distinct variant of a PNG fixture on every call. */
export const uniquePng = (png: Buffer) => markPng(png, (counter = (counter + 1) % 512));
