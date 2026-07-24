import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertClean,
  createClamAvScanner,
  type VirusScanner,
} from '../../src/modules/media/services/virusScanner.service.js';
import { createLogger } from '@bozorlar/logger';
import { AppError } from '@bozorlar/errors';

const logger = createLogger({ service: 'test', level: 'silent', pretty: false });

class StubScanner implements VirusScanner {
  constructor(private readonly behaviour: 'clean' | 'infected' | 'throw') {}
  ping(): Promise<boolean> {
    return Promise.resolve(this.behaviour !== 'throw');
  }
  scan(): Promise<{ clean: boolean; signature: string | null }> {
    if (this.behaviour === 'throw') return Promise.reject(new Error('clamd unreachable'));
    return Promise.resolve(
      this.behaviour === 'clean'
        ? { clean: true, signature: null }
        : { clean: false, signature: 'Eicar-Test-Signature' },
    );
  }
}

/** Asserting on the error code, not the message, since the message is user-facing copy. */
async function captureError(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (AppError.isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the operation to reject, but it resolved');
}

describe('assertClean', () => {
  it('passes a clean file through', async () => {
    await expect(assertClean(new StubScanner('clean'), Buffer.from('ok'), logger)).resolves.toBeUndefined();
  });

  it('reports a scanner outage through ping', async () => {
    await expect(new StubScanner('throw').ping()).resolves.toBe(false);
  });

  it('rejects an infected file with a specific code', async () => {
    const error = await captureError(() =>
      assertClean(new StubScanner('infected'), Buffer.from('bad'), logger),
    );
    expect(error.code).toBe('MEDIA_VIRUS_DETECTED');
    expect(error.status).toBe(422);
  });

  it('FAILS CLOSED when the scanner is unreachable', async () => {
    // ADR-0030. This is the whole point of the module's scanning design: a scanner outage
    // must stop uploads, not wave them through into a bucket moderators open in a browser.
    const error = await captureError(() =>
      assertClean(new StubScanner('throw'), Buffer.from('unknown'), logger),
    );
    expect(error.code).toBe('SYSTEM_DEPENDENCY_UNAVAILABLE');
    expect(error.status).toBe(503);
  });
});

describe('clamd INSTREAM protocol', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  /** Speaks just enough of the clamd wire protocol to verify our framing. */
  async function startFakeClamd(reply: string): Promise<{ port: number; received: Buffer[] }> {
    const received: Buffer[] = [];
    server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        const combined = Buffer.concat(received);
        // The stream ends with a four-byte zero length.
        if (combined.length >= 4 && combined.subarray(-4).readUInt32BE(0) === 0) {
          socket.write(`${reply}\0`);
          socket.end();
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    return { port, received };
  }

  it('frames the stream correctly and parses a clean reply', async () => {
    const { port, received } = await startFakeClamd('stream: OK');
    const scanner = createClamAvScanner('127.0.0.1', port);

    const result = await scanner.scan(Buffer.from('hello world'));
    expect(result.clean).toBe(true);

    const sent = Buffer.concat(received).toString('binary');
    expect(sent.startsWith('zINSTREAM\0')).toBe(true);
    // Command, then a 4-byte length prefix, then the payload, then a zero terminator.
    const payloadLength = Buffer.concat(received).subarray(10, 14).readUInt32BE(0);
    expect(payloadLength).toBe('hello world'.length);
  });

  it('parses a FOUND reply into a signature', async () => {
    const { port } = await startFakeClamd('stream: Eicar-Test-Signature FOUND');
    const scanner = createClamAvScanner('127.0.0.1', port);

    const result = await scanner.scan(Buffer.from('eicar payload'));
    expect(result).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });
});
