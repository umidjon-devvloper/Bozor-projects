import { Socket } from 'node:net';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import type { Logger } from '@bozorlar/logger';

/**
 * ClamAV scanning over the clamd INSTREAM protocol.
 *
 * ADR-0030: this fails closed. Everywhere else an unavailable dependency degrades
 * gracefully; here it must not, because the private bucket holds passport scans that
 * moderators open in a browser. An unscanned file reaching that bucket is the one failure in
 * this module that cannot be undone after the fact.
 */

export interface ScanResult {
  clean: boolean;
  signature: string | null;
}

export interface VirusScanner {
  scan(data: Buffer): Promise<ScanResult>;
  ping(): Promise<boolean>;
}

const CONNECT_TIMEOUT_MS = 5_000;
const SCAN_TIMEOUT_MS = 30_000;
/** clamd's default StreamMaxLength is 25MB; chunks must stay well under it. */
const CHUNK_SIZE = 64 * 1024;

class ClamAvScanner implements VirusScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  private connect(timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.setTimeout(timeoutMs);
      const fail = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error('clamd connection timed out')));
      socket.connect(this.port, this.host, () => {
        socket.removeListener('error', fail);
        socket.setTimeout(0);
        resolve(socket);
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      const socket = await this.connect(CONNECT_TIMEOUT_MS);
      const reply = await new Promise<string>((resolve, reject) => {
        socket.once('data', (chunk: Buffer) => resolve(chunk.toString('ascii')));
        socket.once('error', reject);
        socket.write('zPING\0');
      });
      socket.end();
      return reply.includes('PONG');
    } catch {
      return false;
    }
  }

  async scan(data: Buffer): Promise<ScanResult> {
    const socket = await this.connect(CONNECT_TIMEOUT_MS);

    try {
      return await new Promise<ScanResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('clamd scan timed out'));
        }, SCAN_TIMEOUT_MS);

        let response = '';
        socket.on('data', (chunk: Buffer) => {
          response += chunk.toString('ascii');
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once('close', () => {
          clearTimeout(timer);
          const reply = response.replace(/\0/g, '').trim();
          if (reply.endsWith('OK')) {
            resolve({ clean: true, signature: null });
            return;
          }
          const found = /^stream:\s+(.+)\s+FOUND$/.exec(reply);
          if (found) {
            resolve({ clean: false, signature: found[1] ?? 'unknown' });
            return;
          }
          reject(new Error(`Unexpected clamd response: ${reply || '(empty)'}`));
        });

        // INSTREAM: a null-terminated command, then length-prefixed chunks, then a zero
        // length to signal the end of the stream.
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
          const chunk = data.subarray(offset, offset + CHUNK_SIZE);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.length, 0);
          socket.write(header);
          socket.write(chunk);
        }
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });
    } finally {
      socket.destroy();
    }
  }
}

/**
 * Development-only scanner.
 *
 * This is not a stub that pretends to scan: it reports plainly that scanning is disabled and
 * can only be constructed when MEDIA_SCAN_ENABLED is false, which the config schema forbids
 * in production. It also still detects the EICAR test string, so the upload path can be
 * exercised end to end locally without a ClamAV container.
 */
class DisabledScanner implements VirusScanner {
  private static readonly EICAR =
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

  constructor(private readonly logger: Logger) {
    this.logger.warn('virus scanning is DISABLED; uploads are not being scanned');
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  scan(data: Buffer): Promise<ScanResult> {
    const found = data.includes(DisabledScanner.EICAR);
    return Promise.resolve(
      found ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true, signature: null },
    );
  }
}

/**
 * Constructs a clamd client against an explicit address.
 *
 * Exported separately from the env-reading factory so the wire protocol can be exercised
 * against a fake clamd in tests without reaching through module-level configuration.
 */
export function createClamAvScanner(host: string, port: number): VirusScanner {
  return new ClamAvScanner(host, port);
}

export function createVirusScanner(logger: Logger): VirusScanner {
  return env.MEDIA_SCAN_ENABLED
    ? new ClamAvScanner(env.CLAMAV_HOST, env.CLAMAV_PORT)
    : new DisabledScanner(logger);
}

/**
 * Scans and converts every non-clean outcome into a rejection.
 *
 * A scanner error and a detected virus are treated identically from the caller's point of
 * view: the object does not get stored. That equivalence is the whole point of ADR-0030.
 */
export async function assertClean(
  scanner: VirusScanner,
  data: Buffer,
  logger: Logger,
): Promise<void> {
  let result: ScanResult;
  try {
    result = await scanner.scan(data);
  } catch (cause) {
    logger.error({ err: cause }, 'virus scan failed; rejecting upload');
    throw new AppError(ErrorCode.SYSTEM_DEPENDENCY_UNAVAILABLE, {
      detail: 'File scanning is unavailable; please try again shortly',
      cause,
    });
  }

  if (!result.clean) {
    logger.warn({ signature: result.signature }, 'malicious upload rejected');
    throw new AppError(ErrorCode.MEDIA_VIRUS_DETECTED, {
      detail: 'The uploaded file was rejected by the malware scanner',
      params: { signature: result.signature },
    });
  }
}
