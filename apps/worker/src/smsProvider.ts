import { env } from '@bozorlar/config';
import type { Logger } from '@bozorlar/logger';
import type { SmsSender } from '@bozorlar/notifications';

/**
 * SMS for the worker.
 *
 * The identity module owns the Eskiz adapter for OTP delivery, but the worker cannot import
 * the API app (ADR-0011). Rather than move a working adapter or create a package for one
 * HTTP call, the worker keeps its own — the provider contract is two fields and a POST, and
 * duplicating that is cheaper than the coupling it would otherwise buy.
 */
class ConsoleSms implements SmsSender {
  constructor(private readonly logger: Logger) {
    this.logger.warn({}, 'SMS provider is console; messages are logged, not sent');
  }
  send(to: string, message: string): Promise<void> {
    this.logger.info({ to, message }, 'sms (console provider)');
    return Promise.resolve();
  }
}

class EskizSms implements SmsSender {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly logger: Logger) {}

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const body = new FormData();
    body.set('email', env.ESKIZ_EMAIL ?? '');
    body.set('password', env.ESKIZ_PASSWORD ?? '');
    const response = await fetch('https://notify.eskiz.uz/api/auth/login', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Eskiz auth failed with ${response.status}`);
    const payload = (await response.json()) as { data?: { token?: string } };
    const token = payload.data?.token;
    if (!token) throw new Error('Eskiz auth returned no token');
    this.token = token;
    this.tokenExpiresAt = Date.now() + 25 * 24 * 60 * 60 * 1000;
    return token;
  }

  async send(to: string, message: string): Promise<void> {
    const token = await this.authenticate();
    const body = new FormData();
    body.set('mobile_phone', to.replace('+', ''));
    body.set('message', message);
    body.set('from', '4546');
    const response = await fetch('https://notify.eskiz.uz/api/message/sms/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      this.logger.error({ status: response.status }, 'eskiz send failed');
      throw new Error(`Eskiz send failed with ${response.status}`);
    }
  }
}

export function createSmsProvider(logger: Logger): SmsSender {
  return env.SMS_PROVIDER === 'eskiz' ? new EskizSms(logger) : new ConsoleSms(logger);
}
