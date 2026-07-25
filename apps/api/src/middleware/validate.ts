import type { NextFunction, Request, Response } from 'express';
import type { z} from 'zod';
import { type ZodTypeAny } from 'zod';
import { AppError, ErrorCode, type FieldError, validationFailed } from '@bozorlar/errors';

type Target = 'body' | 'query' | 'params';

function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_root',
    code: issue.code.toUpperCase(),
    params: {
      message: issue.message,
      ...('expected' in issue ? { expected: issue.expected } : {}),
      ...('minimum' in issue ? { minimum: issue.minimum } : {}),
      ...('maximum' in issue ? { maximum: issue.maximum } : {}),
    },
  }));
}

/**
 * Validation at the boundary, layer one of three (ADR-0026). Schemas are `.strict()`, so an
 * unknown field is rejected rather than silently dropped — that is what stops mass
 * assignment before it reaches Mongoose.
 */
export function validate(schema: ZodTypeAny, target: Target = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const fieldErrors = toFieldErrors(result.error);
      const unknownKey = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      next(
        unknownKey
          ? new AppError(ErrorCode.VALIDATION_UNKNOWN_FIELD, {
              detail: unknownKey.message,
              errors: fieldErrors,
            })
          : validationFailed(fieldErrors),
      );
      return;
    }
    // Express 5 makes req.query a getter; assigning to a separate field keeps handlers typed
    // without fighting the framework.
    if (target === 'query') req.validatedQuery = result.data;
    else req[target] = result.data as never;
    next();
  };
}

export const validateBody = (schema: ZodTypeAny) => validate(schema, 'body');
export const validateQuery = (schema: ZodTypeAny) => validate(schema, 'query');
export const validateParams = (schema: ZodTypeAny) => validate(schema, 'params');
