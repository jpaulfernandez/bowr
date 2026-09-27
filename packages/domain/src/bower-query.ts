/**
 * Bower search state (DESIGN 4.5): text, facet filters and sort, kept in the
 * route so opening a piece and coming back restores them. Route parameters
 * carry only these non-sensitive values (ARCHITECTURE 5.2).
 */
import { categories, namedColors, seasons, type Category, type Season } from './taxonomy';

export const bowerSorts = ['recent', 'category', 'color', 'name'] as const;
export type BowerSort = (typeof bowerSorts)[number];

export const bowerSortLabel: Record<BowerSort, string> = {
  recent: 'Recently added',
  category: 'Category',
  color: 'Color',
  name: 'Name',
};

export type BowerQuery = {
  q: string;
  categories: Category[];
  colors: string[];
  seasons: Season[];
  archived: boolean;
  sort: BowerSort;
};

export const emptyBowerQuery: BowerQuery = { q: '', categories: [], colors: [], seasons: [], archived: false, sort: 'recent' };

const colorNames = namedColors.map((c) => c.name) as readonly string[];
const list = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value.join(',') : (value ?? '')).split(',').map((v) => v.trim()).filter(Boolean);
const known = <T extends string>(values: string[], allowed: readonly T[]) =>
  Array.from(new Set(values.filter((v): v is T => (allowed as readonly string[]).includes(v))));

/** Reads route parameters; unknown values are dropped rather than trusted. */
export function parseBowerQuery(params: Record<string, string | string[] | undefined>): BowerQuery {
  const sort = list(params.sort)[0];
  return {
    q: ((Array.isArray(params.q) ? params.q[0] : params.q) ?? '').slice(0, 200),
    categories: known(list(params.category), categories),
    colors: known(list(params.color), colorNames),
    seasons: known(list(params.season), seasons),
    archived: list(params.archived)[0] === '1',
    sort: bowerSorts.includes(sort as BowerSort) ? (sort as BowerSort) : 'recent',
  };
}

/** Route parameters for a query; defaults are left out. */
export function bowerQueryParams(query: BowerQuery): Record<string, string | undefined> {
  return {
    q: query.q.trim() || undefined,
    category: query.categories.join(',') || undefined,
    color: query.colors.join(',') || undefined,
    season: query.seasons.join(',') || undefined,
    archived: query.archived ? '1' : undefined,
    sort: query.sort === 'recent' ? undefined : query.sort,
  };
}

/** The filters for search_items (facets only; text and sort are separate). */
export function searchFilters(query: BowerQuery) {
  return {
    ...(query.categories.length ? { categories: query.categories } : {}),
    ...(query.colors.length ? { colors: query.colors } : {}),
    ...(query.seasons.length ? { seasons: query.seasons } : {}),
    ...(query.archived ? { archived: true } : {}),
  };
}

/** Active facet values as removable chips (the text search is shown in its field). */
export function activeFilterCount(query: BowerQuery): number {
  return query.categories.length + query.colors.length + query.seasons.length + (query.archived ? 1 : 0);
}
