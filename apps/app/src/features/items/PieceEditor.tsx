import type { Item, ItemPatch } from '@bowr/contracts';
import {
  accessoryAttributes,
  categories,
  categoryLabel,
  displayName,
  formalityLabels,
  namedColors,
  patterns,
  seasons,
  subcategories,
  type AccessoryAttribute,
  type Category,
} from '@bowr/domain';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ChipGroup } from '../../components/ChipGroup';
import { RadioGroup } from '../../components/RadioGroup';
import { Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/errors';
import { useUpdateItem } from './queries';

type Draft = {
  name: string;
  category: Category | null;
  subcategory: string | null;
  colors: string[];
  pattern: string | null;
  material: string;
  formality: string | null;
  seasons: string[];
  style_tags: string;
  attributes: Record<string, string | boolean>;
  brand: string;
  size_label: string;
  price: string;
  currency: string;
  purchased_on: string;
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Minor-unit exponent of an ISO currency (2 for PHP/USD, 0 for JPY). */
export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function toDraft(item: Item): Draft {
  const exponent = item.currency ? currencyExponent(item.currency) : 2;
  return {
    name: item.name ?? '',
    category: item.category,
    subcategory: item.subcategory,
    colors: item.colors.map((c) => c.name),
    pattern: item.pattern,
    material: item.material ?? '',
    formality: item.formality ? String(item.formality) : null,
    seasons: item.seasons,
    style_tags: item.style_tags.join(', '),
    attributes: item.attributes,
    brand: item.brand ?? '',
    size_label: item.size_label ?? '',
    price: item.price_minor === null ? '' : (item.price_minor / 10 ** exponent).toFixed(exponent),
    currency: item.currency ?? '',
    purchased_on: item.purchased_on ?? '',
  };
}

const text = (value: string) => (value.trim() === '' ? null : value.trim());
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Problems = Partial<Record<'price' | 'currency' | 'purchased_on' | 'style_tags', string>>;

/** Only the fields that changed are sent, so an edit never overwrites untouched values. */
function toPatch(item: Item, draft: Draft): { patch: ItemPatch; problems: Problems } {
  const problems: Problems = {};
  const patch: ItemPatch = {};
  const put = <K extends keyof ItemPatch>(key: K, value: ItemPatch[K], current: unknown) => {
    if (!same(value, current)) patch[key] = value;
  };
  put('name', text(draft.name), item.name);
  put('category', draft.category, item.category);
  put('subcategory', draft.subcategory, item.subcategory);
  put(
    'colors',
    draft.colors.map((name) => {
      const existing = item.colors.find((c) => c.name === name);
      return existing ?? { name, hex: namedColors.find((c) => c.name === name)!.hex };
    }),
    item.colors,
  );
  put('pattern', draft.pattern as ItemPatch['pattern'], item.pattern);
  put('material', text(draft.material), item.material);
  put('formality', draft.formality ? Number(draft.formality) : null, item.formality);
  put('seasons', draft.seasons as ItemPatch['seasons'], item.seasons);
  const tags = draft.style_tags
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  if (tags.some((tag) => !/^[a-z0-9][a-z0-9 -]{0,23}$/.test(tag)) || tags.length > 10) {
    problems.style_tags = 'Use up to 10 short tags with letters, numbers, spaces or hyphens.';
  } else put('style_tags', Array.from(new Set(tags)), item.style_tags);
  put('attributes', draft.attributes, item.attributes);
  put('brand', text(draft.brand), item.brand);
  put('size_label', text(draft.size_label), item.size_label);

  const currency = draft.currency.trim().toUpperCase();
  if (draft.price.trim() !== '') {
    const amount = Number(draft.price.replace(/,/g, ''));
    if (!/^[A-Z]{3}$/.test(currency)) problems.currency = 'Enter a three-letter currency code, such as PHP.';
    else if (!Number.isFinite(amount) || amount < 0) problems.price = 'Enter the price as a number, such as 1299.00.';
    else {
      put('price_minor', Math.round(amount * 10 ** currencyExponent(currency)), item.price_minor);
      put('currency', currency, item.currency);
    }
  } else {
    put('price_minor', null, item.price_minor);
    if (currency === '') put('currency', null, item.currency);
    else if (!/^[A-Z]{3}$/.test(currency)) problems.currency = 'Enter a three-letter currency code, such as PHP.';
    else put('currency', currency, item.currency);
  }
  const date = draft.purchased_on.trim();
  if (date !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
    problems.purchased_on = 'Use the format YYYY-MM-DD.';
  } else put('purchased_on', date === '' ? null : date, item.purchased_on);
  return { patch, problems };
}

/** "Suggested" marks a value bowr inferred that the member has not confirmed. */
function Suggested({ item, field }: { item: Item; field: string }) {
  const meta = item.field_meta[field];
  if (!meta || meta.source === 'user' || meta.source === 'computed') return null;
  return <Text variant="secondary">{meta.source === 'label' ? 'Read from the care label' : 'Suggested'}</Text>;
}

/** Draft fields the member changed relative to the snapshot the draft started from. */
function dirtyKeys(base: Item, draft: Draft): Array<keyof Draft> {
  const start = toDraft(base);
  return (Object.keys(draft) as Array<keyof Draft>).filter((key) => !same(draft[key], start[key]));
}

export function PieceEditor({ item }: { item: Item }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(item));
  // The server snapshot the draft is based on. Edits are sent relative to it, so
  // a suggestion that arrives meanwhile is neither lost nor overwritten.
  const [base, setBase] = useState<Item>(item);
  const [details, setDetails] = useState(false);
  const [purchase, setPurchase] = useState(false);
  const [problems, setProblems] = useState<Problems>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const request = useRef<{ key: string; body: string } | null>(null);
  const update = useUpdateItem(item);

  // A newer revision (a suggestion, or an edit elsewhere) rebases the draft: the
  // member's own changes stay, everything else shows the latest values.
  if (item.revision !== base.revision && !update.isPending) {
    const keep = dirtyKeys(base, draft);
    const next = toDraft(item);
    for (const key of keep) (next as Record<string, unknown>)[key] = draft[key];
    setDraft(next);
    setBase(item);
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const category = draft.category;
  const attributes = category
    ? (Object.entries(accessoryAttributes) as Array<[AccessoryAttribute, (typeof accessoryAttributes)[AccessoryAttribute]]>).filter(
        ([, rule]) => (rule.categories as readonly string[]).includes(category),
      )
    : [];

  const save = () => {
    setNotice(null);
    const { patch, problems: found } = toPatch(base, draft);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    if (Object.keys(patch).length === 0) {
      setNotice({ tone: 'success', message: 'Nothing to save. Your piece is up to date.' });
      return;
    }
    const body = JSON.stringify({ patch, revision: item.revision });
    if (!request.current || request.current.body !== body) request.current = { key: crypto.randomUUID(), body };
    update.mutate(
      { patch, key: request.current.key },
      {
        onSuccess: () => {
          request.current = null;
          setNotice({ tone: 'success', message: 'Saved. Your edits take priority over suggestions.' });
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
            request.current = null;
            setNotice({
              tone: 'error',
              message: 'This piece changed while you were editing. Your changes are kept on the latest version; check them and save again.',
            });
          } else if (error instanceof ApiError && !error.retryable) {
            request.current = null;
            setNotice({ tone: 'error', message: 'Some values could not be saved. Check them and try again.' });
          } else {
            setNotice({ tone: 'error', message: "This piece hasn't saved yet. Your changes are still here; try again." });
          }
        },
      },
    );
  };

  return (
    <View className="gap-6">
      <View className="gap-4">
        <TextField
          label="Name"
          value={draft.name}
          onChangeText={(value) => set('name', value)}
          maxLength={80}
          hint={`Leave blank to use “${displayName({ ...item, name: null, category: draft.category, subcategory: draft.subcategory })}”.`}
        />
        <View className="gap-1">
          <RadioGroup
            label="Category"
            value={draft.category}
            options={categories.map((c) => ({ value: c, label: categoryLabel[c] }))}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                category: value,
                subcategory: current.subcategory && subcategories[value].includes(current.subcategory) ? current.subcategory : null,
              }))
            }
          />
          <Suggested item={item} field="category" />
        </View>
        <View className="gap-1">
          <ChipGroup
            label="Colors"
            hint="Choose up to 5, main color first."
            max={5}
            values={draft.colors}
            options={namedColors.map((c) => ({ value: c.name, label: capitalize(c.name), swatch: c.hex }))}
            onChange={(value) => set('colors', value)}
          />
          <Suggested item={item} field="colors" />
        </View>
      </View>

      <View className="gap-4">
        <Button
          label={details ? 'Hide details' : 'Show details'}
          variant="quiet"
          className="self-start"
          aria-expanded={details}
          onPress={() => setDetails((open) => !open)}
        />
        {details ? (
          <View className="gap-4">
            {category ? (
              <RadioGroup
                label="Type"
                value={draft.subcategory}
                options={subcategories[category].map((s) => ({ value: s, label: capitalize(s) }))}
                onChange={(value) => set('subcategory', value)}
              />
            ) : (
              <Text variant="secondary">Choose a category to pick a type.</Text>
            )}
            <RadioGroup label="Pattern" value={draft.pattern} options={patterns.map((p) => ({ value: p, label: capitalize(p) }))} onChange={(value) => set('pattern', value)} />
            <View className="gap-1">
              <TextField label="Material" value={draft.material} maxLength={60} onChangeText={(value) => set('material', value)} hint="Editable. A photo-based guess is only a suggestion." />
              <Suggested item={item} field="material" />
            </View>
            <RadioGroup
              label="Formality"
              value={draft.formality}
              options={formalityLabels.map((label, i) => ({ value: String(i + 1), label }))}
              onChange={(value) => set('formality', value)}
            />
            <ChipGroup
              label="Conditions"
              hint="When you would wear it."
              values={draft.seasons}
              options={seasons.map((s) => ({ value: s, label: capitalize(s) }))}
              onChange={(value) => set('seasons', value)}
            />
            <TextField
              label="Style tags"
              value={draft.style_tags}
              onChangeText={(value) => set('style_tags', value)}
              hint="Separate with commas, such as minimal, streetwear."
              error={problems.style_tags}
            />
            {attributes.map(([key, rule]) =>
              key === 'has_logo' ? (
                <RadioGroup
                  key={key}
                  label="Logo"
                  value={draft.attributes.has_logo === undefined ? null : draft.attributes.has_logo ? 'yes' : 'no'}
                  options={[
                    { value: 'yes', label: 'Has a logo' },
                    { value: 'no', label: 'No logo' },
                  ]}
                  onChange={(value) => set('attributes', { ...draft.attributes, has_logo: value === 'yes' })}
                />
              ) : (
                <RadioGroup
                  key={key}
                  label={capitalize(key.replace(/_/g, ' '))}
                  value={typeof draft.attributes[key] === 'string' ? (draft.attributes[key] as string) : null}
                  options={(rule.values as readonly string[]).map((v) => ({ value: v, label: capitalize(v) }))}
                  onChange={(value) => set('attributes', { ...draft.attributes, [key]: value })}
                />
              ),
            )}
          </View>
        ) : null}
      </View>

      <View className="gap-4">
        <Button
          label={purchase ? 'Hide purchase details' : 'Show purchase details'}
          variant="quiet"
          className="self-start"
          aria-expanded={purchase}
          onPress={() => setPurchase((open) => !open)}
        />
        {purchase ? (
          <View className="gap-4">
            <Text variant="secondary">Optional. Price is never required to use bowr.</Text>
            <TextField label="Brand" value={draft.brand} maxLength={60} onChangeText={(value) => set('brand', value)} />
            <TextField label="Size" value={draft.size_label} maxLength={20} onChangeText={(value) => set('size_label', value)} />
            <TextField label="Price paid" value={draft.price} inputMode="decimal" onChangeText={(value) => set('price', value)} error={problems.price} />
            <TextField label="Currency" value={draft.currency} maxLength={3} autoCapitalize="characters" onChangeText={(value) => set('currency', value)} hint="Three letters, such as PHP or USD." error={problems.currency} />
            <TextField label="Purchase date" value={draft.purchased_on} maxLength={10} onChangeText={(value) => set('purchased_on', value)} hint="YYYY-MM-DD" error={problems.purchased_on} />
          </View>
        ) : null}
      </View>

      {notice ? <Banner tone={notice.tone} message={notice.message} /> : null}
      <View className="flex-row flex-wrap gap-3">
        <Button label="Save changes" busy={update.isPending} busyLabel="Saving" onPress={save} />
      </View>
    </View>
  );
}
