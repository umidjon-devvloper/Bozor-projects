import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not await an async handler, so a rejected promise becomes an unhandled
 * rejection and the client hangs until timeout instead of receiving the error envelope.
 * Every async route is wrapped so rejections reach the error middleware.
 *
 * RECONSTRUCTED during repository recovery — the original file was not in the uploaded
 * artifacts. Behaviour is fully determined by its 13 call sites.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
