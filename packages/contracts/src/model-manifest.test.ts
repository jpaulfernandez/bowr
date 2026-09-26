import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ModelManifest } from './model-manifest';

const manifestPath = fileURLToPath(new URL('../../../config/models.yaml', import.meta.url));

describe('config/models.yaml', () => {
  it('matches the manifest schema', () => {
    expect(() => ModelManifest.parse(parse(readFileSync(manifestPath, 'utf8')))).not.toThrow();
  });

  it('rejects unpinned local models and unknown fields', () => {
    const base = { schema_version: 1, tasks: {} };
    expect(
      ModelManifest.safeParse({ ...base, local_models: { cutout: { source: 'x', revision: 'main', license: 'MIT' } } })
        .success,
    ).toBe(false);
    expect(ModelManifest.safeParse({ ...base, local_models: {}, fallback_model: 'free-tier' }).success).toBe(false);
  });
});
