// Blind tag-extraction comparison (P1.07-T1). Every candidate gets the same
// prompt, response schema, validator, labels and photos, through the same
// budget-gated gateway as production (reserve → call → settle), so cost is
// guarded and recorded. The report holds numbers and field values only: no
// photos, file names, prompts or provider payloads.
//
//   pnpm eval:extraction --dataset <dir>/manifest.json --task item_tags [--task <alias>] --out <report.json>
//
// with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AI_ENABLED and GEMINI_API_KEY in
// the environment (the same settings the Edge gateway reads).
//
// The manifest lists owner-approved, already-sanitized photos (for example the
// pilot's stored originals) and their labels; it and the photos stay out of the
// repository:
//   { "items": [{ "id": "p01", "photo": "p01.webp", "labels": { "category": "tops", "subcategory": "shirt", ... } }] }
// Each --task is a configured alias in config/models.yaml with verified prices.
import { runAiTask } from '../../supabase/functions/_shared/ai-gateway.ts';
import { tagsPrompt, tagsResponseSchema, validateTags } from '../../supabase/functions/_shared/item-tags.ts';
import {
  type Labels,
  type Observation,
  pickCandidate,
  scoreCandidate,
} from '../../packages/domain/src/extraction-eval.ts';

type Manifest = { items: Array<{ id: string; photo: string; labels: Labels }> };

const MIME: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

function args() {
  const values = { dataset: '', tasks: [] as string[], out: '', run: crypto.randomUUID() as string };
  for (let i = 0; i < Deno.args.length; i += 2) {
    const [flag, value] = [Deno.args[i], Deno.args[i + 1] ?? ''];
    if (flag === '--dataset') values.dataset = value;
    else if (flag === '--task') values.tasks.push(value);
    else if (flag === '--out') values.out = value;
    else if (flag === '--run') values.run = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!values.dataset || values.tasks.length === 0 || !values.out) {
    throw new Error('usage: --dataset <manifest.json> --task <alias> [--task <alias>] --out <report.json>');
  }
  return values;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Shuffled once per run and shared by every candidate: the order carries no hint
// of the labels, and each candidate sees the same photos in the same order.
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

async function main() {
  const { dataset, tasks, out, run } = args();
  const manifest = JSON.parse(await Deno.readTextFile(dataset)) as Manifest;
  const base = dataset.replace(/[^/]*$/, '');
  const items = shuffled(manifest.items);
  const reports: Record<string, ReturnType<typeof scoreCandidate>> = {};
  for (const task of tasks) {
    const observations: Observation[] = [];
    for (const item of items) {
      const bytes = await Deno.readFile(`${base}${item.photo}`);
      const mimeType = MIME[item.photo.split('.').pop()?.toLowerCase() ?? ''];
      if (!mimeType) throw new Error(`unsupported photo type for item ${item.id}`);
      const started = performance.now();
      const outcome = await runAiTask({
        task,
        // One identity per run, candidate and photo: a rerun never re-sends a billed attempt.
        attemptKey: `eval:${run}:${task}:${item.id}`,
        userId: null,
        jobId: null,
        contents: [{ text: tagsPrompt() }, { inlineData: { mimeType, data: base64(bytes) } }],
        responseSchema: tagsResponseSchema(),
        validate: (value) => validateTags(value) !== null,
      });
      const latencyMs = Math.round(performance.now() - started);
      const predicted = outcome.status === 'completed' ? (validateTags(outcome.output) as Labels | null) : null;
      const costMicros = 'settled_micros' in outcome
        ? outcome.settled_micros
        : 'reserved_micros' in outcome
        ? outcome.reserved_micros
        : null;
      observations.push({ item: item.id, labels: item.labels, predicted, latencyMs, costMicros });
      if (outcome.status === 'refused') {
        // The budget guard stopped the run: record where, and do not continue past it.
        console.error(JSON.stringify({ task, stopped: outcome.reason, after: observations.length }));
        break;
      }
    }
    reports[task] = scoreCandidate(observations);
  }
  const report = {
    run,
    dataset_items: manifest.items.length,
    method: 'Same prompt, schema, validator, photos and order for every candidate; labels never sent.',
    candidates: reports,
    pick: pickCandidate(reports),
    prd_target_unedited_acceptance: 0.8,
  };
  await Deno.writeTextFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, pick: report.pick }));
}

await main();
