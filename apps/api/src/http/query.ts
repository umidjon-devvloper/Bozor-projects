import { AppError, ErrorCode } from '@bozorlar/errors';
import { decodeCursor, encodeCursor } from './cursor.js';

/**
 * Filter, sort and keyset-pagination parsing (API.md 1.6–1.8).
 *
 * Bracket operators were chosen over a query DSL because every filterable field and operator
 * is allowlisted per endpoint. A caller therefore cannot construct a query against an
 * unindexed field, which is the failure mode that makes generic query languages expensive.
 */

export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists';

export type FilterValueType = 'string' | 'number' | 'boolean' | 'date' | 'objectId';

export interface FilterSpec {
  field: string;
  type: FilterValueType;
  operators: readonly FilterOperator[];
  /** Mongo path when it differs from the public field name. */
  path?: string;
}

export interface SortSpec {
  /** Public sort key, e.g. `-createdAt`. */
  key: string;
  /** Mongo sort document. Must be backed by an index (DATABASE.md Part 5). */
  sort: Record<string, 1 | -1>;
}

export interface QuerySpec {
  filters: readonly FilterSpec[];
  sorts: readonly SortSpec[];
  defaultSort: string;
  maxLimit?: number;
}

const OBJECT_ID = /^[a-f\d]{24}$/i;

function coerce(value: string, type: FilterValueType, field: string): unknown {
  switch (type) {
    case 'number': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `Filter "${field}" expects a number`,
          errors: [{ field, code: 'NOT_A_NUMBER' }],
        });
      }
      return parsed;
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `Filter "${field}" expects true or false`,
          errors: [{ field, code: 'NOT_A_BOOLEAN' }],
        });
      }
      return value === 'true';
    }
    case 'date': {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `Filter "${field}" expects an RFC 3339 date`,
          errors: [{ field, code: 'NOT_A_DATE' }],
        });
      }
      return parsed;
    }
    case 'objectId': {
      if (!OBJECT_ID.test(value)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `Filter "${field}" expects an id`,
          errors: [{ field, code: 'NOT_AN_ID' }],
        });
      }
      return value;
    }
    default:
      return value;
  }
}

const MONGO_OPERATOR: Record<Exclude<FilterOperator, 'eq'>, string> = {
  ne: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  nin: '$nin',
  exists: '$exists',
};

export interface ParsedQuery {
  filter: Record<string, unknown>;
  sortKey: string;
  sort: Record<string, 1 | -1>;
  limit: number;
  cursorFilter: Record<string, unknown> | null;
}

export function parseQuery(
  query: Record<string, unknown>,
  spec: QuerySpec,
): ParsedQuery {
  const maxLimit = spec.maxLimit ?? 100;
  const rawLimit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: 'limit must be a positive integer' });
  }
  if (rawLimit > maxLimit) {
    throw new AppError(ErrorCode.PAGINATION_LIMIT_EXCEEDED, {
      detail: `limit must not exceed ${maxLimit}`,
      params: { maxLimit },
    });
  }

  const sortKey = typeof query.sort === 'string' && query.sort.length > 0 ? query.sort : spec.defaultSort;
  const sortSpec = spec.sorts.find((candidate) => candidate.key === sortKey);
  if (!sortSpec) {
    throw new AppError(ErrorCode.SORT_FIELD_NOT_ALLOWED, {
      detail: `Sort "${sortKey}" is not supported here`,
      params: { allowed: spec.sorts.map((s) => s.key) },
    });
  }

  const filter: Record<string, unknown> = {};
  const reserved = new Set(['limit', 'cursor', 'sort', 'fields', 'expand', 'q', 'withTotal']);

  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (reserved.has(rawKey) || rawValue === undefined) continue;

    const match = /^([A-Za-z0-9_.]+)(?:\[([a-z]+)\])?$/.exec(rawKey);
    if (!match) {
      throw new AppError(ErrorCode.FILTER_FIELD_NOT_ALLOWED, { detail: `Unknown filter "${rawKey}"` });
    }
    const [, field = '', rawOperator = 'eq'] = match;
    // The regex yields a plain string; it becomes a FilterOperator only after the spec
    // confirms the field permits it, a few lines below.
    const operator = rawOperator as FilterOperator;

    const filterSpec = spec.filters.find((candidate) => candidate.field === field);
    if (!filterSpec) {
      throw new AppError(ErrorCode.FILTER_FIELD_NOT_ALLOWED, {
        detail: `Filter "${field}" is not supported here`,
        params: { allowed: spec.filters.map((f) => f.field) },
      });
    }
    if (!filterSpec.operators.includes(operator)) {
      throw new AppError(ErrorCode.FILTER_OPERATOR_NOT_ALLOWED, {
        detail: `Operator "${operator}" is not allowed on "${field}"`,
        params: { allowed: filterSpec.operators },
      });
    }

    const path = filterSpec.path ?? field;
    const value = String(rawValue);

    if (operator === 'in' || operator === 'nin') {
      const items = value.split(',').filter(Boolean);
      if (items.length === 0 || items.length > 50) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `"${field}[${operator}]" accepts between 1 and 50 values`,
        });
      }
      const coerced = items.map((item) => coerce(item, filterSpec.type, field));
      filter[path] = { [MONGO_OPERATOR[operator]]: coerced };
      continue;
    }

    if (operator === 'eq') {
      filter[path] = coerce(value, filterSpec.type, field);
      continue;
    }

    const existing = (filter[path] as Record<string, unknown> | undefined) ?? {};
    const coerced =
      operator === 'exists' ? coerce(value, 'boolean', field) : coerce(value, filterSpec.type, field);
    filter[path] = { ...existing, [MONGO_OPERATOR[operator]]: coerced };
  }

  let cursorFilter: Record<string, unknown> | null = null;
  if (typeof query.cursor === 'string' && query.cursor.length > 0) {
    const payload = decodeCursor(query.cursor, sortKey);
    cursorFilter = buildKeysetFilter(sortSpec.sort, payload.k);
  }

  return { filter, sortKey, sort: sortSpec.sort, limit: rawLimit, cursorFilter };
}

/**
 * Builds the keyset predicate for the next page.
 *
 * For a single sort key plus the `_id` tiebreaker this is
 * `(a < last_a) OR (a == last_a AND _id < last_id)` — which an index on `{a, _id}` serves
 * directly, unlike `skip`, which must walk every preceding document.
 */
function buildKeysetFilter(
  sort: Record<string, 1 | -1>,
  keys: (string | number | null)[],
): Record<string, unknown> {
  const fields = Object.keys(sort);
  if (fields.length !== keys.length) {
    throw new AppError(ErrorCode.PAGINATION_INVALID_CURSOR, {
      detail: 'Cursor key length does not match the sort specification',
    });
  }

  const clauses: Record<string, unknown>[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const clause: Record<string, unknown> = {};
    for (let j = 0; j < i; j += 1) {
      const field = fields[j];
      if (field) clause[field] = revive(keys[j]);
    }
    const field = fields[i];
    if (!field) continue;
    const direction = sort[field] ?? 1;
    clause[field] = { [direction === 1 ? '$gt' : '$lt']: revive(keys[i]) };
    clauses.push(clause);
  }
  return clauses.length === 1 ? (clauses[0] ?? {}) : { $or: clauses };
}

/** Cursor values are JSON, so dates arrive as ISO strings and must be restored. */
function revive(value: string | number | null | undefined): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return value ?? null;
}

/** Serialises the sort-key tuple of the last row into the next cursor. */
export function buildNextCursor(
  sortKey: string,
  sort: Record<string, 1 | -1>,
  lastRow: Record<string, unknown>,
): string {
  const keys = Object.keys(sort).map((field) => {
    const value = readPath(lastRow, field);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (value === null || value === undefined) return null;
    return String(value);
  });
  return encodeCursor({ v: 1, s: sortKey, k: keys });
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, segment) =>
        acc !== null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[segment]
          : undefined,
      source,
    );
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Fetches `limit + 1` rows so the presence of a further page is known without a count query,
 * which on a sharded collection would be a scatter-gather scan.
 */
export function toPage<T extends Record<string, unknown>>(
  rows: T[],
  parsed: ParsedQuery,
): Page<T> {
  const hasMore = rows.length > parsed.limit;
  const items = hasMore ? rows.slice(0, parsed.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? buildNextCursor(parsed.sortKey, parsed.sort, last) : null,
  };
}
