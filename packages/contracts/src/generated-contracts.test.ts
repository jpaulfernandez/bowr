// Generates the worker's JSON Schema contracts and fails when committed copies
// drift. Regenerate with: pnpm contracts:generate
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { workerJsonSchemas } from './worker';

const outDir = fileURLToPath(new URL('../../../services/worker/src/bowr_worker/contracts/', import.meta.url));

describe('generated worker contracts', () => {
  for (const [file, schema] of Object.entries(workerJsonSchemas)) {
    it(`${file} matches the Zod source`, () => {
      const generated = `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2)}\n`;
      if (process.env.UPDATE_CONTRACTS === '1') {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(`${outDir}${file}`, generated);
      }
      expect(readFileSync(`${outDir}${file}`, 'utf8')).toBe(generated);
    });
  }
});
