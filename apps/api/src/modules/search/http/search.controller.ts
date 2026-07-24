import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import type { ProductDocument, SearchIndexer, SearchService, ShopDocument } from '@bozorlar/search';
import { sendAccepted, sendData } from '../../../http/envelope.js';

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

const imageUrl = (key: string | undefined, variant: string): string | null =>
  key ? `${env.CDN_BASE_URL.replace(/\/$/, '')}/${key.replace(/\.[^./]+$/, `_${variant}.webp`)}` : null;

/**
 * Search results are a projection, not the catalogue.
 *
 * Only what a result card renders is returned — the client fetches the full product when the
 * shopper taps it. Emitting the whole indexed document would leak internal ranking fields and
 * make the payload several times larger for no benefit.
 */
function toProductResult(document: ProductDocument) {
  return {
    id: document.id,
    name: document.name.split(' ').slice(0, 12).join(' '),
    price: { amount: String(document.price), currency: 'UZS' as const },
    unit: document.unit,
    inStock: document.inStock,
    rating: { avg: document.rating / 100, count: document.ratingCount },
    imageUrl: imageUrl(document.imageKey, 'card'),
    thumbUrl: imageUrl(document.imageKey, 'thumb'),
    shop: { id: document.shopId, name: document.shopName },
    marketId: document.marketId,
    categoryId: document.categoryId,
  };
}

function toShopResult(document: ShopDocument) {
  return {
    id: document.id,
    name: document.name,
    marketId: document.marketId,
    marketName: document.marketName ?? null,
    stall: [document.sectionCode, document.stallNo].filter(Boolean).join('-') || null,
    rating: { avg: document.rating / 100, count: document.ratingCount },
    productCount: document.productCount,
    logoUrl: imageUrl(document.logoKey, 'thumb'),
  };
}

export function createSearchController(deps: { search: SearchService; indexer: SearchIndexer }) {
  const { search, indexer } = deps;

  return {
    async products(req: Request, res: Response): Promise<void> {
      const query = req.validatedQuery as Parameters<SearchService['products']>[0];
      const result = await search.products(query);
      // Short and public: a result page for the same query is the same for everyone, and a
      // minute of caching absorbs the burst when a promotion goes out.
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      sendData(res, {
        items: result.items.map(toProductResult),
        found: result.found,
        page: result.page,
        perPage: result.perPage,
        facets: result.facets,
      });
    },

    async shops(req: Request, res: Response): Promise<void> {
      const query = req.validatedQuery as Parameters<SearchService['shops']>[0];
      const result = await search.shops(query);
      res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
      sendData(res, {
        items: result.items.map(toShopResult),
        found: result.found,
        page: result.page,
        perPage: result.perPage,
      });
    },

    async suggest(req: Request, res: Response): Promise<void> {
      const { q } = req.validatedQuery as { q: string };
      res.setHeader('Cache-Control', 'public, max-age=300');
      sendData(res, { suggestions: await search.suggest(q) });
    },

    /**
     * Rebuilds the index behind a fresh alias.
     *
     * Returns 202 immediately: a full rebuild takes minutes on a real catalogue, and holding
     * an HTTP connection open for it would time out somewhere between here and the operator.
     * Progress is in the worker's logs.
     */
    async reindex(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      void auth;
      void indexer.reindexAll().catch(() => undefined);
      sendAccepted(res, { started: true });
    },

    async health(_req: Request, res: Response): Promise<void> {
      const healthy = await search.healthy();
      res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable' });
    },
  };
}

export type SearchController = ReturnType<typeof createSearchController>;
