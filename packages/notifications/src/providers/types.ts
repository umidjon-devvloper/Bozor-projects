export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Deep link the client opens on tap. */
  targetUrl: string | null;
}

export interface PushResult {
  token: string;
  ok: boolean;
  messageId: string | null;
  /** Provider error code, verbatim, so retry and retirement decisions stay honest. */
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PushProvider {
  readonly name: string;
  readonly platform: 'ANDROID' | 'IOS' | 'ANY';
  send(messages: readonly PushMessage[]): Promise<PushResult[]>;
  healthy(): Promise<boolean>;
}
