import { describe, expect, it } from 'vitest';
import {
  Channel,
  NotificationCategory,
  TEMPLATES,
  TEMPLATES_BY_TYPE,
  TRANSACTIONAL_CATEGORIES,
  DEAD_TOKEN_ERRORS,
  RETRYABLE_PROVIDER_ERRORS,
  interpolate,
  isWithinQuietHours,
  renderTemplate,
} from '@bozorlar/notifications';
import { NotificationCategorySchema, ChannelSchema } from '@bozorlar/contracts';

describe('template rendering', () => {
  const template = TEMPLATES_BY_TYPE.get('order.ready_for_pickup');

  it('renders in every locale the platform serves', () => {
    for (const locale of ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const) {
      const rendered = renderTemplate(template!, locale, { shopName: 'Aziz sabzavot', stall: 'B-42' });
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.body).toContain('B-42');
      expect(rendered.body).not.toContain('{{');
    }
  });

  it('refuses to send a half-rendered message', () => {
    // "Your order at  is ready" is worse than nothing, because nobody notices it is broken.
    expect(() => renderTemplate(template!, 'uz-Latn', { shopName: 'Aziz' })).toThrow(/requires "stall"/);
  });

  it('rejects an unknown placeholder rather than leaving it visible', () => {
    expect(() => interpolate('Hello {{missing}}', {})).toThrow(/missing values/);
  });

  it('substitutes without evaluating anything', () => {
    // The value is inserted verbatim: a template is not an expression language.
    expect(interpolate('{{a}} and {{b}}', { a: '{{b}}', b: 'x' })).toBe('{{b}} and x');
  });

  it('truncates rather than dropping a long message', () => {
    const rendered = renderTemplate(template!, 'en', { shopName: 'x'.repeat(600), stall: 'B-42' });
    expect(rendered.body.length).toBeLessThanOrEqual(400);
    expect(rendered.body.endsWith('…')).toBe(true);
  });

  it('falls back through locales rather than failing', () => {
    // Every template supplies uz; the resolver walks to it when a locale is absent.
    const rendered = renderTemplate(template!, 'uz-Cyrl', { shopName: 'Aziz', stall: 'B-42' });
    expect(rendered.body.length).toBeGreaterThan(0);
  });
});

describe('template catalogue', () => {
  it('declares every variable its copy actually uses', () => {
    // A template whose body references a variable it does not declare would throw at send
    // time, in production, for one specific locale.
    for (const template of TEMPLATES) {
      for (const locale of ['uz', 'uzCyrl', 'ru', 'en'] as const) {
        const text = `${template.title[locale] ?? ''} ${template.body[locale] ?? ''}`;
        for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(template.variables, `${template.type} (${locale}) uses ${match[1]}`).toContain(match[1]);
        }
      }
    }
  });

  it('provides Uzbek copy for every template', () => {
    for (const template of TEMPLATES) {
      expect(template.title.uz.length, template.type).toBeGreaterThan(0);
      expect(template.body.uz.length, template.type).toBeGreaterThan(0);
    }
  });

  it('has unique types', () => {
    expect(new Set(TEMPLATES.map((t) => t.type)).size).toBe(TEMPLATES.length);
  });

  it('sends the messages a person is waiting on by SMS as well as push', () => {
    // A buyer standing in a bazaar may not have the app open; a seller may not have data.
    for (const type of ['order.ready_for_pickup', 'seller.deactivated', 'seller.approved']) {
      expect(TEMPLATES_BY_TYPE.get(type)?.channels, type).toContain(Channel.SMS);
    }
  });

  it('keeps the wire enums and the server enums in step', () => {
    const categories = [...new Set(TEMPLATES.map((t) => t.category))];
    for (const category of categories) {
      expect(NotificationCategorySchema.options).toContain(category);
    }
    expect([...ChannelSchema.options].sort()).toEqual(Object.values(Channel).sort());
  });
});

describe('opt-out policy', () => {
  it('makes only marketing optional', () => {
    // Order and wallet messages are the service the user signed up for, not a mailing list.
    expect(TRANSACTIONAL_CATEGORIES).toContain(NotificationCategory.ORDER);
    expect(TRANSACTIONAL_CATEGORIES).toContain(NotificationCategory.WALLET);
    expect(TRANSACTIONAL_CATEGORIES).not.toContain(NotificationCategory.MARKETING);
  });

  it('has no marketing templates yet, so nothing is silently opt-out today', () => {
    expect(TEMPLATES.every((template) => template.category !== NotificationCategory.MARKETING)).toBe(true);
  });
});

describe('quiet hours', () => {
  it('is computed in the recipient\'s timezone, not the server\'s', () => {
    // 20:00 UTC is 01:00 in Tashkent — inside quiet hours — and 21:00 in London, which is not.
    const instant = new Date('2026-07-24T20:00:00Z');
    expect(isWithinQuietHours(instant, 'Asia/Tashkent', 22, 8)).toBe(true);
    expect(isWithinQuietHours(instant, 'Europe/London', 22, 8)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    // Tashkent is UTC+5. 10:00 UTC is 15:00 local — the middle of the trading day.
    expect(isWithinQuietHours(new Date('2026-07-24T10:00:00Z'), 'Asia/Tashkent', 22, 8)).toBe(false);
    // 18:00 UTC is 23:00 local, and 01:00 UTC is 06:00 local: both sides of midnight.
    expect(isWithinQuietHours(new Date('2026-07-24T18:00:00Z'), 'Asia/Tashkent', 22, 8)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-07-24T01:00:00Z'), 'Asia/Tashkent', 22, 8)).toBe(true);
  });

  it('treats the boundaries as start-inclusive and end-exclusive', () => {
    // 17:00 UTC = 22:00 Tashkent (quiet); 03:00 UTC = 08:00 Tashkent (no longer quiet).
    expect(isWithinQuietHours(new Date('2026-07-24T17:00:00Z'), 'Asia/Tashkent', 22, 8)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-07-24T03:00:00Z'), 'Asia/Tashkent', 22, 8)).toBe(false);
  });
});

describe('provider error classification', () => {
  it('retires a token the provider says is dead', () => {
    // Retrying these forever slowly turns the fan-out into noise.
    for (const code of ['UNREGISTERED', 'BadDeviceToken', 'DeviceNotRegistered']) {
      expect(DEAD_TOKEN_ERRORS.has(code), code).toBe(true);
      expect(RETRYABLE_PROVIDER_ERRORS.has(code), code).toBe(false);
    }
  });

  it('retries a transient outage', () => {
    for (const code of ['UNAVAILABLE', 'INTERNAL', 'TIMEOUT']) {
      expect(RETRYABLE_PROVIDER_ERRORS.has(code), code).toBe(true);
      expect(DEAD_TOKEN_ERRORS.has(code), code).toBe(false);
    }
  });

  it('never classes a code as both', () => {
    for (const code of DEAD_TOKEN_ERRORS) {
      expect(RETRYABLE_PROVIDER_ERRORS.has(code), code).toBe(false);
    }
  });
});
