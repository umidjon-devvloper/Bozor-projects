import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import { sendCollection, sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import { Permission } from '../../authz/index.js';
import type { CategoryService } from '../services/category.service.js';
import type { CreateProductCommand, ProductService } from '../services/product.service.js';
import {
  toCategoryResponse,
  toCategoryTreeResponse,
  toProductResponse,
  toUnitResponse,
  type ViewOptions,
} from './mappers.js';

const PERIOD_DAYS: Record<string, number> = { '30d': 30, '90d': 90, '1y': 365 };

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function options(req: Request, privileged: boolean): ViewOptions {
  return {
    locale: req.locale,
    raw: req.query.raw === 'true',
    privileged,
    cdnBaseUrl: env.CDN_BASE_URL,
  };
}

/** A seller sees privileged fields on their own products; a moderator on any. */
function sellerView(req: Request, shopId: string | null): ViewOptions {
  const auth = req.auth;
  const privileged = Boolean(
    auth &&
      ((shopId !== null && auth.shopIds.includes(shopId)) ||
        auth.permissions.has(Permission.PRODUCT_MODERATE)),
  );
  return options(req, privileged);
}

export function createCatalogController(deps: {
  categories: CategoryService;
  products: ProductService;
}) {
  const { categories, products } = deps;

  return {
    // ---- public reference data ----
    async units(req: Request, res: Response): Promise<void> {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      sendData(res, (await categories.listUnits()).map((unit) => toUnitResponse(unit, options(req, false))));
    },

    async categoryTree(req: Request, res: Response): Promise<void> {
      const rootId = typeof req.query.rootId === 'string' ? req.query.rootId : undefined;
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      sendData(res, toCategoryTreeResponse(await categories.tree(rootId), options(req, false)));
    },

    async category(req: Request, res: Response): Promise<void> {
      const category = await categories.get(requireParam(req.params.idOrSlug, 'Category'));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      sendData(res, toCategoryResponse(category, options(req, false)));
    },

    // ---- public catalogue ----
    async listProducts(req: Request, res: Response): Promise<void> {
      const page = await products.listPublic(req.query);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      sendCollection(
        res,
        page.items.map((product) => toProductResponse(product, sellerView(req, product.shopId))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async getProduct(req: Request, res: Response): Promise<void> {
      const product = await products.getPublic(requireParam(req.params.idOrSlug, 'Product'));
      sendData(res, toProductResponse(product, sellerView(req, product.shopId)));
    },

    async priceHistory(req: Request, res: Response): Promise<void> {
      const period = (req.validatedQuery as { period: string } | undefined)?.period ?? '30d';
      const history = await products.priceHistory(
        requireParam(req.params.id, 'Product'),
        PERIOD_DAYS[period] ?? 30,
      );
      res.setHeader('Cache-Control', 'public, max-age=3600');
      sendData(res, history);
    },

    // ---- seller ----
    async listMyProducts(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const page = await products.listForSeller(req.query, auth.shopIds);
      sendCollection(
        res,
        page.items.map((product) => toProductResponse(product, options(req, true))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async createProduct(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const product = await products.create(req.body as CreateProductCommand, {
        userId: auth.userId,
        shopIds: auth.shopIds,
      });
      sendCreated(res, toProductResponse(product, options(req, true)), `/api/v1/products/${product.id}`);
    },

    async getMyProduct(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const product = await products.getForSeller(requireParam(req.params.id, 'Product'), auth.shopIds);
      sendData(res, toProductResponse(product, options(req, true)));
    },

    async updateProduct(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const product = await products.update(
        requireParam(req.params.id, 'Product'),
        { userId: auth.userId, shopIds: auth.shopIds },
        req.body as Record<string, never>,
      );
      sendData(res, toProductResponse(product, options(req, true)));
    },

    async setPrice(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const product = await products.setPrice(
        requireParam(req.params.id, 'Product'),
        { userId: auth.userId, shopIds: auth.shopIds },
        req.body as { price: string; oldPrice?: string | null },
      );
      sendData(res, toProductResponse(product, options(req, true)));
    },

    async setStock(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const { stockQty } = req.body as { stockQty: string };
      const product = await products.setStock(
        requireParam(req.params.id, 'Product'),
        { userId: auth.userId, shopIds: auth.shopIds },
        stockQty,
      );
      sendData(res, toProductResponse(product, options(req, true)));
    },

    async archiveProduct(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await products.archive(requireParam(req.params.id, 'Product'), {
        userId: auth.userId,
        shopIds: auth.shopIds,
      });
      sendNoContent(res);
    },

    // ---- admin ----
    async createCategory(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const category = await categories.create(req.body as never, auth.userId);
      sendCreated(res, toCategoryResponse(category, options(req, true)));
    },

    async updateCategory(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const category = await categories.update(
        requireParam(req.params.id, 'Category'),
        req.body as Record<string, never>,
        auth.userId,
      );
      sendData(res, toCategoryResponse(category, options(req, true)));
    },

    async deactivateCategory(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await categories.deactivate(requireParam(req.params.id, 'Category'), auth.userId);
      sendNoContent(res);
    },

    async moderateProduct(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as { approved: boolean; reason?: string };
      const product = await products.moderate(requireParam(req.params.id, 'Product'), auth.userId, body);
      sendData(res, toProductResponse(product, options(req, true)));
    },
  };
}

export type CatalogController = ReturnType<typeof createCatalogController>;
