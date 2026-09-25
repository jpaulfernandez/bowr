// Fails when a Tailwind spacing utility uses a step that the design-token scale
// does not define. Such classes generate no CSS, so layouts break silently.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = createRequire(import.meta.url)('@bowr/design-tokens/tokens.json');
const allowed = new Set(['0', ...Object.keys(tokens.space)]);
const utility =
  /(?<![\w[-])-?(?:[a-z]+:)*-?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|w|h|min-w|min-h|max-w|max-h|top|left|right|bottom|inset|basis|translate-x|translate-y|space-x|space-y)-(\d+)\b/g;

const failures = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.tsx')) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(utility)) {
        if (!allowed.has(match[2])) failures.push(`${relative(root, path)}: ${match[0]}`);
      }
    }
  }
}
walk(join(root, 'src'));
if (failures.length > 0) {
  console.error(`Spacing utilities outside the token scale (${[...allowed].join(', ')}):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('Class names use only token spacing steps.');
