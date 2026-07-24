import { AppError, ErrorCode } from '@bozorlar/errors';

export type Currency = 'UZS';

/** 1 UZS = 100 tiyin. All money is stored and transported in tiyin (ADR-0004). */
export const MINOR_UNITS_PER_MAJOR = 100n;

/** BSON Int64 bounds. Exceeding these silently corrupts data, so we fail loudly instead. */
const INT64_MAX = 9_223_372_036_854_775_807n;
const INT64_MIN = -9_223_372_036_854_775_808n;

const AMOUNT_PATTERN = /^-?\d{1,19}$/;

export interface MoneyDTO {
  amount: string;
  currency: Currency;
}

/**
 * Immutable money value object.
 *
 * Arithmetic is integer-only: doubles cannot represent 0.1, and a marketplace that disagrees
 * with a seller's own arithmetic loses the seller, not the argument (ADR-0004).
 */
export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: Currency,
  ) {}

  static of(minor: bigint | number | string, currency: Currency = 'UZS'): Money {
    let value: bigint;
    if (typeof minor === 'bigint') {
      value = minor;
    } else if (typeof minor === 'number') {
      if (!Number.isSafeInteger(minor)) {
        throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
          detail: `Amount ${minor} is not a safe integer; pass a string or bigint instead`,
        });
      }
      value = BigInt(minor);
    } else {
      if (!AMOUNT_PATTERN.test(minor)) {
        throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
          detail: `Amount "${minor}" is not an integer string of minor units`,
        });
      }
      value = BigInt(minor);
    }
    Money.assertInRange(value);
    return new Money(value, currency);
  }

  static zero(currency: Currency = 'UZS'): Money {
    return new Money(0n, currency);
  }

  /** Parses the wire representation (ADR-0028). */
  static fromDTO(dto: MoneyDTO): Money {
    return Money.of(dto.amount, dto.currency);
  }

  /** Builds from a major-unit decimal string such as "18000.50". Input parsing only. */
  static fromMajor(value: string, currency: Currency = 'UZS'): Money {
    const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
    if (!match) {
      throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
        detail: `"${value}" is not a valid major-unit amount`,
      });
    }
    const [, sign, whole, fraction = ''] = match;
    const padded = fraction.padEnd(2, '0');
    const minor = BigInt(whole ?? '0') * MINOR_UNITS_PER_MAJOR + BigInt(padded);
    return Money.of(sign === '-' ? -minor : minor, currency);
  }

  private static assertInRange(value: bigint): void {
    if (value > INT64_MAX || value < INT64_MIN) {
      throw new AppError(ErrorCode.MONEY_OVERFLOW, {
        detail: 'Amount exceeds the Int64 range supported by the database',
      });
    }
  }

  private assertSameCurrency(other: Money): void {
    // Widened to `string` deliberately. `Currency` is a single-member union today, so inside
    // the mismatch branch TypeScript narrows both operands to `never` and the guard's own
    // error message becomes uninterpolatable. The guard is not dead code — it is the check
    // that stops a second currency being added unsafely (ADR-0004) — so the types are
    // widened at the boundary rather than the check being removed.
    const mine: string = this.currency;
    const theirs: string = other.currency;
    if (theirs !== mine) {
      throw new AppError(ErrorCode.MONEY_CURRENCY_MISMATCH, {
        detail: `Cannot combine ${mine} with ${theirs}`,
      });
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.of(-this.minor, this.currency);
  }

  abs(): Money {
    return Money.of(this.minor < 0n ? -this.minor : this.minor, this.currency);
  }

  /** Multiplies by an integer factor. Exact — no rounding involved. */
  multiply(factor: bigint | number): Money {
    const f = typeof factor === 'bigint' ? factor : BigInt(Math.trunc(factor));
    return Money.of(this.minor * f, this.currency);
  }

  /**
   * Applies a rate expressed in basis points (300 = 3.00%), rounding half-up once.
   * This is the only way commission is ever calculated (COMMISSION_SPEC.md).
   */
  percentBp(bp: number): Money {
    if (!Number.isInteger(bp) || bp < 0) {
      throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
        detail: `Basis points must be a non-negative integer, received ${bp}`,
      });
    }
    return Money.of(divideRoundHalfUp(this.minor * BigInt(bp), 10_000n), this.currency);
  }

  /**
   * Clamps into [min, max]; either bound may be omitted.
   *
   * Accepts null as well as undefined because optional bounds come out of the database as
   * null — a commission rule with no floor is `minCharge: null`, not a missing property.
   */
  clamp(min?: Money | null, max?: Money | null): Money {
    // Floor first, then ceiling against the floored value — the order matters when the two
    // bounds contradict each other, and `max` winning is the safer of the two answers.
    const floored: Money = min && this.lessThan(min) ? min : this;
    return max && floored.greaterThan(max) ? max : floored;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }
  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }
  lessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor <= other.minor;
  }
  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }
  greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor >= other.minor;
  }
  isZero(): boolean {
    return this.minor === 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }

  static sum(values: readonly Money[], currency: Currency = 'UZS'): Money {
    return values.reduce<Money>((acc, m) => acc.add(m), Money.zero(currency));
  }

  /** Wire form (ADR-0028): a string, so no JSON parser can truncate it. */
  toDTO(): MoneyDTO {
    return { amount: this.minor.toString(), currency: this.currency };
  }

  toJSON(): MoneyDTO {
    return this.toDTO();
  }

  /** Database form: Int64 as a string, cast to Long by the Mongoose layer. */
  toStorage(): string {
    return this.minor.toString();
  }

  toString(): string {
    return `${this.toMajorString()} ${this.currency}`;
  }

  toMajorString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / MINOR_UNITS_PER_MAJOR;
    const fraction = abs % MINOR_UNITS_PER_MAJOR;
    const body =
      fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(2, '0')}`;
    return negative ? `-${body}` : body;
  }
}

/**
 * Integer division rounding half away from zero.
 *
 * Banker's rounding is the usual default in finance, but it is surprising to a merchant
 * checking arithmetic by hand at a stall. Half-up is what a person does on paper, so the
 * platform and the seller reach the same number (COMMISSION_SPEC.md).
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}
