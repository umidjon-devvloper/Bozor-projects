import type { Logger } from '@bozorlar/logger';
import { env } from '@bozorlar/config';

export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<void>;
}

/**
 * Local development provider. Writing the code to the log is intentional here and gated on
 * SMS_PROVIDER=console, which the env schema will not accept in production configurations
 * that set eskiz/playmobile.
 */
class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}
  send(to: string, message: string): Promise<void> {
    this.logger.info({ to, message }, 'sms (console provider)');
    return Promise.resolve();
  }
}

/**
 * Eskiz.uz adapter. Kept behind the SmsProvider interface so a failover provider is an
 * adapter swap rather than a change to any caller (ADR-0014).
 */
class EskizSmsProvider implements SmsProvider {
  readonly name = 'eskiz';
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

export function createSmsProvider(logger: Logger): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case 'eskiz':
      return new EskizSmsProvider(logger);
    case 'playmobile':
      // Failover provider is wired in Phase 8 alongside the notification dispatcher.
      return new ConsoleSmsProvider(logger);
    default:
      return new ConsoleSmsProvider(logger);
  }
}
