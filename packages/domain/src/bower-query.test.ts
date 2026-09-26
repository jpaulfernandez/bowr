import { describe, expect, it } from 'vitest';
import { activeFilterCount, bowerQueryParams, emptyBowerQuery, parseBowerQuery, searchFilters } from './bower-query';

describe('Bower query in the route', () => {
  it('round-trips text, facets, archived and sort', () => {
    const query = { q: 'navy shirt', categories: ['tops' as const, 'bottoms' as const], colors: ['navy'], seasons: ['hot' as const], archived: true, sort: 'name' as const };
    expect(parseBowerQuery(bowerQueryParams(query))).toEqual(query);
    expect(activeFilterCount(query)).toBe(5);
    expect(searchFilters(query)).toEqual({ categories: ['tops', 'bottoms'], colors: ['navy'], seasons: ['hot'], archived: true });
  });

  it('leaves defaults out and drops unknown or repeated values instead of trusting them', () => {
    expect(bowerQueryParams(emptyBowerQuery)).toEqual({
      q: undefined,
      category: undefined,
      color: undefined,
      season: undefined,
      archived: undefined,
      sort: undefined,
    });
    expect(parseBowerQuery({ category: 'capes,tops,tops', color: '#fff,navy', sort: 'price', archived: 'yes' })).toEqual({
      ...emptyBowerQuery,
      categories: ['tops'],
      colors: ['navy'],
    });
    expect(parseBowerQuery({ q: 'x'.repeat(500) }).q).toHaveLength(200);
    expect(searchFilters(emptyBowerQuery)).toEqual({});
  });
});
