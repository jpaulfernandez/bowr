import {
  activeFilterCount,
  bowerSortLabel,
  bowerSorts,
  categories,
  categoryLabel,
  namedColors,
  seasons,
  type BowerQuery,
} from '@bowr/domain';
import { Pressable, Text as RNText, View } from 'react-native';
import { Button } from '../../components/Button';
import { ChipGroup } from '../../components/ChipGroup';
import { RadioGroup } from '../../components/RadioGroup';

const seasonLabel: Record<string, string> = { hot: 'Hot', mild: 'Mild', cold: 'Cold', rainy: 'Rainy' };

/**
 * Facet filters (OR within a facet, AND across facets), sort and the archived
 * view. Shown inline when opened; the active values stay visible as chips.
 */
export function BowerFilters({ query, onChange }: { query: BowerQuery; onChange: (next: BowerQuery) => void }) {
  return (
    <View role="region" aria-label="Filters and sort" className="gap-4 rounded-control border border-divider bg-surface p-4">
      <ChipGroup
        label="Category"
        values={query.categories}
        options={categories.map((c) => ({ value: c, label: categoryLabel[c] }))}
        onChange={(values) => onChange({ ...query, categories: values })}
      />
      <ChipGroup
        label="Color"
        values={query.colors}
        options={namedColors.map((c) => ({ value: c.name, label: c.name.charAt(0).toUpperCase() + c.name.slice(1), swatch: c.hex }))}
        onChange={(values) => onChange({ ...query, colors: values })}
      />
      <ChipGroup
        label="Conditions"
        values={query.seasons}
        options={seasons.map((s) => ({ value: s, label: seasonLabel[s] ?? s }))}
        onChange={(values) => onChange({ ...query, seasons: values })}
      />
      <RadioGroup
        label="Show"
        value={query.archived ? 'archived' : 'active'}
        options={[
          { value: 'active', label: 'Pieces in use' },
          { value: 'archived', label: 'Archived pieces' },
        ]}
        onChange={(value) => onChange({ ...query, archived: value === 'archived' })}
      />
      <RadioGroup
        label="Sort"
        value={query.sort}
        options={bowerSorts.map((s) => ({ value: s, label: bowerSortLabel[s] }))}
        onChange={(sort) => onChange({ ...query, sort })}
      />
    </View>
  );
}

/** Removable chips for every active filter, and Clear all. */
export function ActiveFilters({ query, onChange }: { query: BowerQuery; onChange: (next: BowerQuery) => void }) {
  if (activeFilterCount(query) === 0) return null;
  const chips: Array<{ key: string; label: string; remove: () => void }> = [
    ...query.categories.map((c) => ({
      key: `c-${c}`,
      label: categoryLabel[c],
      remove: () => onChange({ ...query, categories: query.categories.filter((v) => v !== c) }),
    })),
    ...query.colors.map((c) => ({ key: `k-${c}`, label: c, remove: () => onChange({ ...query, colors: query.colors.filter((v) => v !== c) }) })),
    ...query.seasons.map((s) => ({
      key: `s-${s}`,
      label: seasonLabel[s] ?? s,
      remove: () => onChange({ ...query, seasons: query.seasons.filter((v) => v !== s) }),
    })),
    ...(query.archived ? [{ key: 'archived', label: 'Archived', remove: () => onChange({ ...query, archived: false }) }] : []),
  ];
  return (
    <View role="list" aria-label="Active filters" className="flex-row flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <View role="listitem" key={chip.key}>
          <Pressable
            role="button"
            aria-label={`Remove filter ${chip.label}`}
            onPress={chip.remove}
            className="min-h-target flex-row items-center gap-2 rounded-full border border-accent bg-accent-soft px-3 py-2"
          >
            <RNText className="text-body text-accent">{chip.label}</RNText>
            <RNText aria-hidden className="text-body text-accent">
              ×
            </RNText>
          </Pressable>
        </View>
      ))}
      <View role="listitem">
        <Button
          label="Clear all"
          variant="quiet"
          onPress={() => onChange({ ...query, categories: [], colors: [], seasons: [], archived: false })}
        />
      </View>
    </View>
  );
}
