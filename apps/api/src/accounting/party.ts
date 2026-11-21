import { BadRequestException } from '@nestjs/common';
import {
  AccountNormalBalance,
  AccountSubledger,
  AccountType,
  AccountingPartyType,
} from '@prisma/client';

export type PartyAccount = {
  subledger: AccountSubledger;
  isActive: boolean;
  isPostable: boolean;
};

export type PartyLine = {
  customerId?: string | null;
  supplierId?: string | null;
  partyType?: AccountingPartyType | null;
  debit?: number | null;
  credit?: number | null;
};

export function normalBalanceForType(type: AccountType): AccountNormalBalance {
  if (type === AccountType.ASSET || type === AccountType.EXPENSE) {
    return AccountNormalBalance.DEBIT;
  }
  return AccountNormalBalance.CREDIT;
}

export function assertPartyOnLine(account: PartyAccount, line: PartyLine) {
  if (!account.isActive) throw new BadRequestException('الحساب غير نشط');
  if (!account.isPostable) throw new BadRequestException('الحساب مش قابل للترحيل (حساب أب)');

  const hasCustomer = Boolean(line.customerId);
  const hasSupplier = Boolean(line.supplierId);
  if (hasCustomer && hasSupplier) {
    throw new BadRequestException('السطر مش ينفع يربط عميل ومورد مع بعض');
  }

  let partyType = line.partyType ?? AccountingPartyType.NONE;
  if (hasCustomer) partyType = AccountingPartyType.CUSTOMER;
  else if (hasSupplier) partyType = AccountingPartyType.SUPPLIER;
  else if (partyType === AccountingPartyType.CUSTOMER || partyType === AccountingPartyType.SUPPLIER) {
    throw new BadRequestException('نوع الطرف محدد من غير عميل أو مورد');
  }

  if (account.subledger === AccountSubledger.AR) {
    if (partyType !== AccountingPartyType.CUSTOMER || !hasCustomer) {
      throw new BadRequestException('حساب الذمم المدينة لازم يكون مربوط بعميل');
    }
    if (hasSupplier) throw new BadRequestException('حساب الذمم المدينة مش يقبل مورد');
  } else if (account.subledger === AccountSubledger.AP) {
    if (partyType !== AccountingPartyType.SUPPLIER || !hasSupplier) {
      throw new BadRequestException('حساب الذمم الدائنة لازم يكون مربوط بمورد');
    }
    if (hasCustomer) throw new BadRequestException('حساب الذمم الدائنة مش يقبل عميل');
  } else if (partyType !== AccountingPartyType.NONE || hasCustomer || hasSupplier) {
    throw new BadRequestException('الحساب ده مش حساب أطراف — امسح العميل/المورد من السطر');
  }

  return partyType;
}

export function openingPartyKey(input: {
  partyType?: AccountingPartyType | null;
  customerId?: string | null;
  supplierId?: string | null;
}) {
  if (input.customerId) return `CUSTOMER:${input.customerId}`;
  if (input.supplierId) return `SUPPLIER:${input.supplierId}`;
  return 'NONE';
}
