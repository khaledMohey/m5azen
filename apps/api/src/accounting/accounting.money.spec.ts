import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { AccountSubledger, AccountType, AccountingPartyType } from '@prisma/client';
import { assertBalanced, fromCents, roundMoney, toCents } from './money';
import { assertPartyOnLine, normalBalanceForType } from './party';

function throwsArabic(fn: () => void) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof BadRequestException);
    const body = err.getResponse();
    const message = typeof body === 'string' ? body : (body as { message?: string }).message;
    assert.equal(typeof message, 'string');
    assert.ok(String(message).length > 0);
    return true;
  });
}

describe('accounting money', () => {
  it('rounds to 2 decimals', () => {
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(10.1), 10.1);
    assert.equal(roundMoney(0.1 + 0.2), 0.3);
  });

  it('converts to and from integer cents without float drift', () => {
    assert.equal(toCents(10.1), 1010);
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(fromCents(1010), 10.1);
    assert.equal(fromCents(1), 0.01);
  });

  it('assertBalanced accepts equal debit/credit cents', () => {
    const result = assertBalanced([
      { debit: 100.1, credit: 0 },
      { debit: 0, credit: 50.05 },
      { debit: 0, credit: 50.05 },
    ]);
    assert.equal(result.debitCents, 10010);
    assert.equal(result.creditCents, 10010);
  });

  it('assertBalanced rejects unbalanced and invalid lines', () => {
    throwsArabic(() => assertBalanced([{ debit: 10, credit: 0 }, { debit: 0, credit: 9.99 }]));
    throwsArabic(() => assertBalanced([{ debit: 5, credit: 5 }]));
    throwsArabic(() => assertBalanced([{ debit: 0, credit: 0 }, { debit: 1, credit: 0 }]));
    throwsArabic(() => assertBalanced([]));
  });
});

describe('accounting party', () => {
  it('sets normal balance from account type', () => {
    assert.equal(normalBalanceForType(AccountType.ASSET), 'DEBIT');
    assert.equal(normalBalanceForType(AccountType.EXPENSE), 'DEBIT');
    assert.equal(normalBalanceForType(AccountType.LIABILITY), 'CREDIT');
    assert.equal(normalBalanceForType(AccountType.EQUITY), 'CREDIT');
    assert.equal(normalBalanceForType(AccountType.REVENUE), 'CREDIT');
  });

  it('requires customer on AR and supplier on AP', () => {
    assert.equal(
      assertPartyOnLine(
        { subledger: AccountSubledger.AR, isActive: true, isPostable: true },
        { customerId: 'c1', debit: 10, credit: 0 },
      ),
      AccountingPartyType.CUSTOMER,
    );
    assert.equal(
      assertPartyOnLine(
        { subledger: AccountSubledger.AP, isActive: true, isPostable: true },
        { supplierId: 's1', debit: 0, credit: 10 },
      ),
      AccountingPartyType.SUPPLIER,
    );
    throwsArabic(() =>
      assertPartyOnLine(
        { subledger: AccountSubledger.AR, isActive: true, isPostable: true },
        { debit: 10, credit: 0 },
      ),
    );
    throwsArabic(() =>
      assertPartyOnLine(
        { subledger: AccountSubledger.AP, isActive: true, isPostable: true },
        { customerId: 'c1', debit: 10, credit: 0 },
      ),
    );
    throwsArabic(() =>
      assertPartyOnLine(
        { subledger: AccountSubledger.NONE, isActive: true, isPostable: true },
        { customerId: 'c1', debit: 10, credit: 0 },
      ),
    );
    throwsArabic(() =>
      assertPartyOnLine(
        { subledger: AccountSubledger.AR, isActive: true, isPostable: true },
        { customerId: 'c1', supplierId: 's1', debit: 10, credit: 0 },
      ),
    );
    throwsArabic(() =>
      assertPartyOnLine(
        { subledger: AccountSubledger.NONE, isActive: false, isPostable: true },
        { debit: 10, credit: 0 },
      ),
    );
  });
});
