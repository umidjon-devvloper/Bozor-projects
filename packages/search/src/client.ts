import { AppError, ErrorCode } from '@bozorlar/errors';
import { REQUEST_TIMEOUT_MS } from './constants.js';

/**
 * Typesense REST client.
 *
 * Written against the published HTTP API rather than the official SDK, for the same reason as
 * the push providers: the surface we use is five endpoints, and going direct keeps the error
 * bodies — which is where the useful information is — instead of a wrapped exception.
 */
export interface TypesenseConfig {
  url: string;
  apiKey: string;
}

export interface FieldDefinition {
  name: string;
  type: 'string' | 'string[]' | 'int32' | 'int64' | 'float' | 'bool' | 'geopoint' | 'auto';
  facet?: boolean;
  optional?: boolean;
  index?: boolean;
  sort?: boolean;
}

export interface CollectionSchema {
  name: string;
  fields: FieldDefinition[];
  default_sorting_field?: string;
}

export interface SearchHit<T> {
  document: T;
  text_match?: number;
  highlight?: Record<string, unknown>;
}

export interface SearchResponse<T> {
  found: number;
  page: number;
  hits: Array<SearchHit<T>>;
  facet_counts?: Array<{
    field_name: string;
    counts: Array<{ value: string; count: number }>;
  }>;
  search_time_ms?: number;
}

export function createTypesenseClient(config: TypesenseConfig) {
  const base = config.url.replace(/\/$/, '');

  async function request<T>(
    path: string,
    init: { method: string; body?: string; contentType?: string } = { method: 'GET' },
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          'X-TYPESENSE-API-KEY': config.apiKey,
          ...(init.body ? { 'Content-Type': init.contentType ?? 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // A search outage must be reported as one, not disguised as an empty result set: zero
      // hits and "the engine is down" are very different answers to a shopper.
      throw new AppError(ErrorCode.SEARCH_UNAVAILABLE, {
        detail: 'The search service did not respond',
        cause,
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new AppError(ErrorCode.SEARCH_COLLECTION_MISSING, {
          detail: `Search collection not found: ${path}`,
        });
      }
      throw new AppError(ErrorCode.SEARCH_UNAVAILABLE, {
        detail: `Search service returned ${response.status}`,
        params: { body: body.slice(0, 300) },
      });
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async healthy(): Promise<boolean> {
      try {
        const health = await request<{ ok?: boolean }>('/health');
        return health.ok === true;
      } catch {
        return false;
      }
    },

    async createCollection(schema: CollectionSchema): Promise<void> {
      await request('/collections', { method: 'POST', body: JSON.stringify(schema) });
    },

    async dropCollection(name: string): Promise<void> {
      try {
        await request(`/collections/${name}`, { method: 'DELETE' });
      } catch (error) {
        // Already gone is the desired state, not a failure.
        if (AppError.isAppError(error) && error.code === ErrorCode.SEARCH_COLLECTION_MISSING) return;
        throw error;
      }
    },

    async listCollections(): Promise<Array<{ name: string; num_documents: number }>> {
      return request<Array<{ name: string; num_documents: number }>>('/collections');
    },

    /**
     * Bulk import as JSONL.
     *
     * Typesense answers with one JSON object per line rather than an overall status, so a
     * partial failure looks like success at the HTTP level. The per-line results are parsed
     * and counted, because "imported 4 998 of 5 000" is the only useful form of that answer.
     */
    async importDocuments(
      collection: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      action: 'create' | 'upsert' | 'emplace' = 'upsert',
    ): Promise<{ imported: number; failed: Array<{ error: string; document: string }> }> {
      if (documents.length === 0) return { imported: 0, failed: [] };
      const jsonl = documents.map((document) => JSON.stringify(document)).join('\n');
      const raw = await request<string>(
        `/collections/${collection}/documents/import?action=${action}`,
        { method: 'POST', body: jsonl, contentType: 'text/plain' },
      );

      let imported = 0;
      const failed: Array<{ error: string; document: string }> = [];
      for (const line of String(raw).split('\n').filter(Boolean)) {
        try {
          const result = JSON.parse(line) as { success?: boolean; error?: string; document?: string };
          if (result.success) imported += 1;
          else failed.push({ error: result.error ?? 'unknown', document: result.document ?? '' });
        } catch {
          failed.push({ error: 'unparseable import response line', document: line.slice(0, 200) });
        }
      }
      return { imported, failed };
    },

    async upsertDocument(collection: string, document: Record<string, unknown>): Promise<void> {
      await request(`/collections/${collection}/documents?action=upsert`, {
        method: 'POST',
        body: JSON.stringify(document),
      });
    },

    async deleteDocument(collection: string, id: string): Promise<void> {
      try {
        await request(`/collections/${collection}/documents/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch (error) {
        if (AppError.isAppError(error) && error.code === ErrorCode.SEARCH_COLLECTION_MISSING) return;
        throw error;
      }
    },

    async search<T>(collection: string, params: Record<string, string>): Promise<SearchResponse<T>> {
      const query = new URLSearchParams(params).toString();
      return request<SearchResponse<T>>(`/collections/${collection}/documents/search?${query}`);
    },

    /** Repoints an alias. The last step of a reindex, and the whole reason for the indirection. */
    async upsertAlias(alias: string, collectionName: string): Promise<void> {
      await request(`/aliases/${alias}`, {
        method: 'PUT',
        body: JSON.stringify({ collection_name: collectionName }),
      });
    },

    async resolveAlias(alias: string): Promise<string | null> {
      try {
        const result = await request<{ collection_name?: string }>(`/aliases/${alias}`);
        return result.collection_name ?? null;
      } catch {
        return null;
      }
    },
  };
}

export type TypesenseClient = ReturnType<typeof createTypesenseClient>;
