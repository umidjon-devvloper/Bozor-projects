import { AppError, ErrorCode } from '@bozorlar/errors';
import { Money, divideRoundHalfUp } from './Money.js';

/** 1 unit = 1000 milli-units (ADR-0025). 2.5 kg is stored as 2500. */
export const MILLI_PER_UNIT = 1000n;

export interface QuantityDTO {
  value: string;
  unit: string;
}

/**
 * Immutable quantity in integer milli-units.
 *
 * ADR-0004 removed floats from money but left them in quantity, which reintroduced the same
 * error on the other operand of qty x unitPrice. ADR-0025 closed that.
 */
export class Quantity {
  private constructor(
    readonly milli: bigint,
    readonly unit: string,
  ) {}

  static of(milli: bigint | number | string, unit: string): Quantity {
    let value: bigint;
    if (typeof milli === 'bigint') value = milli;
    else if (typeof milli === 'number') {
      if (!Number.isSafeInteger(milli)) {
        throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
          detail: `Quantity ${milli} is not a safe integer of milli-units`,
        });
      }
      value = BigInt(milli);
    } else {
      if (!/^\d{1,19}$/.test(milli)) {
        throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
          detail: `Quantity "${milli}" is not an integer string of milli-units`,
        });
      }
      value = BigInt(milli);
    }
    if (value < 0n) {
      throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, { detail: 'Quantity cannot be negative' });
    }
    return new Quantity(value, unit);
  }

  static zero(unit: string): Quantity {
    return new Quantity(0n, unit);
  }

  static fromDTO(dto: QuantityDTO): Quantity {
    return Quantity.of(dto.value, dto.unit);
  }

  /** Parses user input such as "2.5" into milli-units. */
  static fromDecimal(value: string, unit: string): Quantity {
    const match = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(value.trim());
    if (!match) {
      throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
        detail: `"${value}" is not a valid quantity (max 3 decimal places)`,
      });
    }
    const [, whole, fraction = ''] = match;
    return Quantity.of(BigInt(whole ?? '0') * MILLI_PER_UNIT + BigInt(fraction.padEnd(3, '0')), unit);
  }

  private assertSameUnit(other: Quantity): void {
    if (other.unit !== this.unit) {
      throw new AppError(ErrorCode.MONEY_CURRENCY_MISMATCH, {
        detail: `Cannot combine quantities in ${this.unit} and ${other.unit}`,
      });
    }
  }

  add(other: Quantity): Quantity {
    this.assertSameUnit(other);
    return Quantity.of(this.milli + other.milli, this.unit);
  }

  subtract(other: Quantity): Quantity {
    this.assertSameUnit(other);
    if (other.milli > this.milli) {
      throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
        detail: 'Quantity subtraction would produce a negative result',
      });
    }
    return Quantity.of(this.milli - other.milli, this.unit);
  }

  /**
   * lineTotal = roundHalfUp(qtyMilli * unitPrice / 1000).
   * The single definition of a line total in the system (DATABASE.md 4.2).
   */
  multiplyPrice(unitPrice: Money): Money {
    return Money.of(divideRoundHalfUp(this.milli * unitPrice.minor, MILLI_PER_UNIT), unitPrice.currency);
  }

  /** Relative difference from another quantity in basis points. Drives ADR-0006 tolerance. */
  deltaBpFrom(base: Quantity): number {
    this.assertSameUnit(base);
    if (base.milli === 0n) return 0;
    const diff = this.milli > base.milli ? this.milli - base.milli : base.milli - this.milli;
    return Number(divideRoundHalfUp(diff * 10_000n, base.milli));
  }

  isMultipleOf(step: Quantity): boolean {
    this.assertSameUnit(step);
    if (step.milli === 0n) return true;
    return this.milli % step.milli === 0n;
  }

  equals(other: Quantity): boolean {
    return this.unit === other.unit && this.milli === other.milli;
  }
  lessThan(other: Quantity): boolean {
    this.assertSameUnit(other);
    return this.milli < other.milli;
  }
  greaterThan(other: Quantity): boolean {
    this.assertSameUnit(other);
    return this.milli > other.milli;
  }
  isZero(): boolean {
    return this.milli === 0n;
  }

  toDTO(): QuantityDTO {
    return { value: this.milli.toString(), unit: this.unit };
  }
  toJSON(): QuantityDTO {
    return this.toDTO();
  }
  toStorage(): string {
    return this.milli.toString();
  }

  toDecimalString(decimalPlaces = 3): string {
    const whole = this.milli / MILLI_PER_UNIT;
    const fraction = this.milli % MILLI_PER_UNIT;
    if (decimalPlaces === 0 || fraction === 0n) return whole.toString();
    return `${whole}.${fraction.toString().padStart(3, '0').slice(0, decimalPlaces).replace(/0+$/, '')}`;
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.unit}`;
  }
}
