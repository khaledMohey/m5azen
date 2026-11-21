import { BadRequestException } from '@nestjs/common';

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) throw new BadRequestException('مبلغ غير صالح');
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function toCents(value: number): number {
  if (!Number.isFinite(value)) throw new BadRequestException('مبلغ غير صالح');
  return Math.round(value * 100);
}

export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) throw new BadRequestException('مبلغ غير صالح');
  return roundMoney(cents / 100);
}

export type MoneyLine = { debit?: number | null; credit?: number | null };

/** Assert debit cents === credit cents (no float tolerance). */
export function assertBalanced(lines: MoneyLine[]) {
  if (!lines?.length) throw new BadRequestException('القيد لازم يكون فيه سطور');
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const d = toCents(Number(line.debit || 0));
    const c = toCents(Number(line.credit || 0));
    if (d < 0 || c < 0) throw new BadRequestException('المدين والدائن لازم يكونوا موجبين');
    if (d > 0 && c > 0) throw new BadRequestException('السطر مش ينفع يكون مدين ودائن في نفس الوقت');
    if (d === 0 && c === 0) throw new BadRequestException('السطر لازم يكون فيه مبلغ مدين أو دائن');
    debit += d;
    credit += c;
  }
  if (debit !== credit) {
    throw new BadRequestException(
      `القيد غير متوازن: مدين ${fromCents(debit)} ≠ دائن ${fromCents(credit)}`,
    );
  }
  return { debitCents: debit, creditCents: credit };
}
