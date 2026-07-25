import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import type { Locale } from '@bozorlar/types';
import { sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import type { CartService } from '../services/cart.service.js';
import type { QuoteService } from '../services/quote.service.js';
import { toCartResponse, toQuoteResponse, type ViewOptions } from './mappers.js';

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function options(req: Request): ViewOptions {
  return { locale: req.locale, cdnBaseUrl: env.CDN_BASE_URL };
}

export function createCheckoutController(deps: { cart: CartService; quotes: QuoteService }) {
  const { cart, quotes } = deps;

  /** Cart and quote responses are personal and must never be cached by a proxy. */
  function noStore(res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store');
  }

  return {
    async getCart(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      noStore(res);
      sendData(res, toCartResponse(await cart.get(auth.userId), options(req)));
    },

    async addItem(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const { productId, qty } = req.body as { productId: string; qty: string };
      noStore(res);
      sendCreated(res, toCartResponse(await cart.addItem(auth.userId, productId, qty), options(req)));
    },

    async updateItem(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const { qty } = req.body as { qty: string };
      noStore(res);
      sendData(
        res,
        toCartResponse(
          await cart.setQuantity(auth.userId, requireParam(req.params.lineId, 'Cart line'), qty),
          options(req),
        ),
      );
    },

    async removeItem(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      noStore(res);
      sendData(
        res,
        toCartResponse(
          await cart.removeLine(auth.userId, requireParam(req.params.lineId, 'Cart line')),
          options(req),
        ),
      );
    },

    async clearCart(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await cart.clear(auth.userId);
      sendNoContent(res);
    },

    async mergeCart(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const { items } = req.body as { items: Array<{ productId: string; qty: string }> };
      const result = await cart.merge(auth.userId, items);
      noStore(res);
      sendData(res, {
        ...toCartResponse(result.cart, options(req)),
        // Rejected lines are reported rather than silently dropped, so the buyer knows what
        // did not survive the sign-in.
        rejected: result.rejected,
      });
    },

    async createQuote(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as { lineIds?: string[] };
      const result = await quotes.createQuote({
        buyerId: auth.userId,
        ...(body.lineIds !== undefined ? { lineIds: body.lineIds } : {}),
      });
      noStore(res);
      sendData(res, toQuoteResponse(result.quote, result.issues, options(req)));
    },

    async getQuote(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const quote = await quotes.getQuote(requireParam(req.params.quoteId, 'Quote'), auth.userId);
      noStore(res);
      sendData(res, toQuoteResponse(quote, [], options(req)));
    },
  };
}

export type CheckoutController = ReturnType<typeof createCheckoutController>;
