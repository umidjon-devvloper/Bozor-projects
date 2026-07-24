import { AppError, ErrorCode, type FieldError } from '@bozorlar/errors';
import { AttributeType } from '../catalog.constants.js';
import type { AttributeDefinition } from '../models/category.model.js';

/**
 * Validates a product's attributes against its category's schema.
 *
 * Definitions are inherited down the tree and overridden by key, so "Oziq-ovqat" can declare
 * `origin` once and every food subcategory gets it, while "Go'sht" can redefine it with a
 * narrower option list.
 */
export function mergeAttributeSchemas(
  ancestorsFirst: ReadonlyArray<readonly AttributeDefinition[]>,
): AttributeDefinition[] {
  const merged = new Map<string, AttributeDefinition>();
  for (const schema of ancestorsFirst) {
    for (const definition of schema) merged.set(definition.key, definition);
  }
  return [...merged.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

export function validateAttributes(
  input: Record<string, unknown>,
  schema: readonly AttributeDefinition[],
): Record<string, unknown> {
  const errors: FieldError[] = [];
  const allowed = new Map(schema.map((definition) => [definition.key, definition]));
  const output: Record<string, unknown> = {};

  // Unknown keys are rejected rather than dropped: silently discarding a seller's input is
  // how "I filled that in and it vanished" support tickets happen.
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      errors.push({
        field: `attributes.${key}`,
        code: 'UNKNOWN_ATTRIBUTE',
        params: { allowed: [...allowed.keys()] },
      });
    }
  }

  for (const definition of schema) {
    const value = input[definition.key];

    if (value === undefined || value === null || value === '') {
      if (definition.required) {
        errors.push({ field: `attributes.${definition.key}`, code: 'REQUIRED_ATTRIBUTE' });
      }
      continue;
    }

    switch (definition.type) {
      case AttributeType.STRING: {
        if (typeof value !== 'string' || value.length > 200) {
          errors.push({ field: `attributes.${definition.key}`, code: 'EXPECTED_STRING' });
          continue;
        }
        output[definition.key] = value.trim();
        break;
      }
      case AttributeType.NUMBER: {
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(parsed)) {
          errors.push({ field: `attributes.${definition.key}`, code: 'EXPECTED_NUMBER' });
          continue;
        }
        output[definition.key] = parsed;
        break;
      }
      case AttributeType.BOOLEAN: {
        if (typeof value !== 'boolean') {
          errors.push({ field: `attributes.${definition.key}`, code: 'EXPECTED_BOOLEAN' });
          continue;
        }
        output[definition.key] = value;
        break;
      }
      case AttributeType.ENUM: {
        if (typeof value !== 'string' || !definition.options.includes(value)) {
          errors.push({
            field: `attributes.${definition.key}`,
            code: 'NOT_AN_ALLOWED_OPTION',
            params: { options: definition.options },
          });
          continue;
        }
        output[definition.key] = value;
        break;
      }
      default: {
        errors.push({ field: `attributes.${definition.key}`, code: 'UNSUPPORTED_ATTRIBUTE_TYPE' });
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(ErrorCode.CATALOG_ATTRIBUTE_INVALID, {
      detail: 'Product attributes do not match the category',
      errors,
    });
  }
  return output;
}
