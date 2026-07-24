import { AppError, ErrorCode } from '@bozorlar/errors';
import { resolveLocalized, type Locale, type LocalizedText } from '@bozorlar/types';
import type { NotificationTemplate } from './templates.js';
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from './constants.js';

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Fills a template.
 *
 * Deliberately not a general expression evaluator: the only thing a placeholder can do is
 * name a variable, and a missing one is an error rather than an empty string. A push
 * notification reading "Your order at  is ready" is worse than one that never arrives,
 * because the second gets noticed.
 */
export function interpolate(text: string, variables: Readonly<Record<string, string>>): string {
  const missing: string[] = [];
  const rendered = text.replace(PLACEHOLDER, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      missing.push(key);
      return '';
    }
    return value;
  });
  if (missing.length > 0) {
    throw new AppError(ErrorCode.NOTIFICATION_TEMPLATE_INVALID, {
      detail: `Template is missing values for: ${missing.join(', ')}`,
      params: { missing },
    });
  }
  return rendered;
}

export interface RenderedNotification {
  title: string;
  body: string;
  locale: Locale;
}

export function renderTemplate(
  template: NotificationTemplate,
  locale: Locale,
  variables: Readonly<Record<string, string>>,
): RenderedNotification {
  for (const required of template.variables) {
    if (variables[required] === undefined) {
      throw new AppError(ErrorCode.NOTIFICATION_TEMPLATE_INVALID, {
        detail: `Template "${template.type}" requires "${required}"`,
        params: { missing: [required] },
      });
    }
  }

  const title = interpolate(pick(template.title, locale), variables);
  const body = interpolate(pick(template.body, locale), variables);

  return {
    // Truncated rather than rejected: a long shop name should not stop the message going out,
    // and both providers silently cut anyway.
    title: title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title,
    body: body.length > MAX_BODY_LENGTH ? `${body.slice(0, MAX_BODY_LENGTH - 1)}…` : body,
    locale,
  };
}

function pick(text: LocalizedText, locale: Locale): string {
  return resolveLocalized(text, locale);
}

/**
 * Whether a marketing message may be sent right now, in the recipient's own timezone.
 *
 * Uses Intl rather than the server clock for the same reason opening hours do: the server
 * runs in UTC, and 22:00 in Tashkent is 17:00 there.
 */
export function isWithinQuietHours(now: Date, timezone: string, startHour: number, endHour: number): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  });
  const hour = Number(formatter.format(now)) % 24;
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}
