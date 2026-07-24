import { describe, expect, it } from 'vitest';
import { buildNextCursor, parseQuery, toPage, type QuerySpec } from '../../src/http/query.js';

const spec: QuerySpec = {
  filters: [
    { field: 'marketId', type: 'objectId', operators: ['eq', 'in'] },
    { field: 'rating', type: 'number', operators: ['gte'], path: 'ratingBayesian' },
    { field: 'isVisible', type: 'boolean', operators: ['eq'] },
  ],
  sorts: [
    { key: '-rating', sort: { ratingBayesian: -1, _id: -1 } },
    { key: '-createdAt', sort: { createdAt: -1, _id: -1 } },
  ],
  defaultSort: '-rating',
};

const OID = '665f1a2b3c4d5e6f7a8b9c0d';

describe('parseQuery', () => {
  it('maps public field names to their mongo paths', () => {
    const parsed = parseQuery({ 'rating[gte]': '450' }, spec);
    expect(parsed.filter).toEqual({ ratingBayesian: { $gte: 450 } });
  });

  it('rejects a filter that is not allowlisted', () => {
    // The point of the allowlist: a caller must not be able to query an unindexed field.
    expect(() => parseQuery({ ownerId: OID }, spec)).toThrow(/not supported/);
  });

  it('rejects an operator that is not allowed on that field', () => {
    expect(() => parseQuery({ 'rating[lt]': '450' }, spec)).toThrow(/not allowed/);
  });

  it('rejects an unlisted sort', () => {
    expect(() => parseQuery({ sort: 'salesCount' }, spec)).toThrow(/not supported/);
  });

  it('coerces types and rejects malformed values', () => {
    expect(parseQuery({ isVisible: 'true' }, spec).filter).toEqual({ isVisible: true });
    expect(() => parseQuery({ isVisible: 'yes' }, spec)).toThrow();
    expect(() => parseQuery({ marketId: 'not-an-id' }, spec)).toThrow();
    expect(() => parseQuery({ 'rating[gte]': 'abc' }, spec)).toThrow();
  });

  it('bounds $in list length', () => {
    const many = Array.from({ length: 51 }, () => OID).join(',');
    expect(() => parseQuery({ 'marketId[in]': many }, spec)).toThrow(/between 1 and 50/);
  });

  it('enforces the limit ceiling', () => {
    expect(parseQuery({ limit: '50' }, spec).limit).toBe(50);
    expect(() => parseQuery({ limit: '500' }, spec)).toThrow(/exceed/);
  });

  it('builds a keyset predicate that an index can serve', () => {
    const cursor = buildNextCursor('-rating', { ratingBayesian: -1, _id: -1 }, {
      ratingBayesian: 430,
      _id: OID,
    });
    const parsed = parseQuery({ cursor, sort: '-rating' }, spec);
    // (rating < 430) OR (rating == 430 AND _id < lastId) — no skip, no scan.
    expect(parsed.cursorFilter).toEqual({
      $or: [
        { ratingBayesian: { $lt: 430 } },
        { ratingBayesian: 430, _id: { $lt: OID } },
      ],
    });
  });

  it('refuses a cursor issued for a different sort', () => {
    const cursor = buildNextCursor('-rating', { ratingBayesian: -1, _id: -1 }, {
      ratingBayesian: 430,
      _id: OID,
    });
    expect(() => parseQuery({ cursor, sort: '-createdAt' }, spec)).toThrow();
  });
});

describe('toPage', () => {
  it('detects a further page without a count query', () => {
    const parsed = parseQuery({ limit: '2' }, spec);
    const rows = [
      { _id: 'a', ratingBayesian: 500 },
      { _id: 'b', ratingBayesian: 450 },
      { _id: 'c', ratingBayesian: 400 },
    ];
    const page = toPage(rows, parsed);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('reports the last page correctly', () => {
    const parsed = parseQuery({ limit: '5' }, spec);
    const page = toPage([{ _id: 'a', ratingBayesian: 500 }], parsed);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
