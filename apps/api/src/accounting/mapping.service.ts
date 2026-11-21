import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountNormalBalance,
  AccountResolutionMode,
  AccountSubledger,
  AccountType,
  AccountingEvent,
  AccountingRole,
  MappingAmountSource,
  MappingSide,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalBalanceForType } from './party';
import { AuditService } from './audit.service';

export type MappingLineInput = {
  role: AccountingRole;
  side: MappingSide;
  resolutionMode?: AccountResolutionMode;
  amountSource: MappingAmountSource;
  amountParam?: number | null;
  accountId?: string | null;
  isRequired?: boolean;
  lineOrder?: number;
  notes?: string | null;
};

type SeedAccount = {
  code: string;
  name: string;
  type: AccountType;
  subledger?: AccountSubledger;
  isPostable?: boolean;
};

const SEED_ACCOUNTS: SeedAccount[] = [
  { code: '1100', name: 'النقدية بالصندوق والبنك', type: AccountType.ASSET },
  { code: '1200', name: 'الذمم المدينة', type: AccountType.ASSET, subledger: AccountSubledger.AR },
  { code: '1300', name: 'المخزون', type: AccountType.ASSET },
  { code: '1400', name: 'ضريبة مشتريات مدينة', type: AccountType.ASSET },
  { code: '1500', name: 'الأصول الثابتة', type: AccountType.ASSET },
  { code: '1510', name: 'مجمع إهلاك الأصول الثابتة', type: AccountType.ASSET },
  { code: '2100', name: 'الذمم الدائنة', type: AccountType.LIABILITY, subledger: AccountSubledger.AP },
  // 2200 محجوز لضريبة المبيعات — مستحقات الرواتب على 2300
  { code: '2200', name: 'ضريبة مبيعات دائنة', type: AccountType.LIABILITY },
  { code: '2300', name: 'رواتب مستحقة', type: AccountType.LIABILITY },
  { code: '3100', name: 'حقوق الملكية', type: AccountType.EQUITY },
  { code: '3200', name: 'أرباح مرحّلة', type: AccountType.EQUITY },
  { code: '4100', name: 'المبيعات', type: AccountType.REVENUE },
  { code: '5100', name: 'تكلفة البضاعة المباعة', type: AccountType.EXPENSE },
  { code: '5200', name: 'المصروفات', type: AccountType.EXPENSE },
  { code: '5210', name: 'مصروف الرواتب', type: AccountType.EXPENSE },
  { code: '5220', name: 'مصروف العمولات', type: AccountType.EXPENSE },
  { code: '5300', name: 'مصروف الإهلاك', type: AccountType.EXPENSE },
];

type SeedMappingLine = {
  role: AccountingRole;
  side: MappingSide;
  amountSource: MappingAmountSource;
  accountCode?: string;
  resolutionMode?: AccountResolutionMode;
  isRequired?: boolean;
};

const SEED_MAPPINGS: { event: AccountingEvent; lines: SeedMappingLine[] }[] = [
  {
    event: AccountingEvent.SALE_CONFIRM,
    lines: [
      { role: AccountingRole.ACCOUNTS_RECEIVABLE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '1200' },
      { role: AccountingRole.SALES_REVENUE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_NET, accountCode: '4100' },
      { role: AccountingRole.SALES_TAX_PAYABLE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_TAX, accountCode: '2200', isRequired: false },
      { role: AccountingRole.COGS, side: MappingSide.DEBIT, amountSource: MappingAmountSource.LINE_COGS_SUM, accountCode: '5100', isRequired: false },
      { role: AccountingRole.INVENTORY, side: MappingSide.CREDIT, amountSource: MappingAmountSource.LINE_COGS_SUM, accountCode: '1300', isRequired: false },
    ],
  },
  {
    event: AccountingEvent.SALE_RECEIPT,
    lines: [
      { role: AccountingRole.CASH, side: MappingSide.DEBIT, amountSource: MappingAmountSource.TENDER_AMOUNT, accountCode: '1100', resolutionMode: AccountResolutionMode.CASH_ACCOUNT },
      { role: AccountingRole.ACCOUNTS_RECEIVABLE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.TENDER_AMOUNT, accountCode: '1200' },
    ],
  },
  {
    event: AccountingEvent.PURCHASE_CONFIRM,
    lines: [
      { role: AccountingRole.INVENTORY, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_NET, accountCode: '1300' },
      { role: AccountingRole.PURCHASE_TAX_RECEIVABLE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_TAX, accountCode: '1400', isRequired: false },
      { role: AccountingRole.ACCOUNTS_PAYABLE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '2100' },
    ],
  },
  {
    event: AccountingEvent.PURCHASE_PAYMENT,
    lines: [
      { role: AccountingRole.ACCOUNTS_PAYABLE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.TENDER_AMOUNT, accountCode: '2100' },
      { role: AccountingRole.CASH, side: MappingSide.CREDIT, amountSource: MappingAmountSource.TENDER_AMOUNT, accountCode: '1100', resolutionMode: AccountResolutionMode.CASH_ACCOUNT },
    ],
  },
  {
    event: AccountingEvent.EXPENSE_CREATE,
    lines: [
      { role: AccountingRole.EXPENSE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '5200' },
      { role: AccountingRole.CASH, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '1100', resolutionMode: AccountResolutionMode.CASH_ACCOUNT },
    ],
  },
  {
    event: AccountingEvent.SALE_COGS_ADJUST,
    lines: [
      { role: AccountingRole.COGS, side: MappingSide.DEBIT, amountSource: MappingAmountSource.COGS_DELTA, accountCode: '5100' },
      { role: AccountingRole.INVENTORY, side: MappingSide.CREDIT, amountSource: MappingAmountSource.COGS_DELTA, accountCode: '1300' },
    ],
  },
  {
    event: AccountingEvent.SALE_RETURN,
    lines: [
      // عكس إيراد/ذمم عند وجود قيمة مرتجع
      { role: AccountingRole.SALES_REVENUE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_NET, accountCode: '4100', isRequired: false },
      { role: AccountingRole.SALES_TAX_PAYABLE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_TAX, accountCode: '2200', isRequired: false },
      { role: AccountingRole.ACCOUNTS_RECEIVABLE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '1200', isRequired: false },
      // إعادة مخزون وعكس COGS
      { role: AccountingRole.INVENTORY, side: MappingSide.DEBIT, amountSource: MappingAmountSource.LINE_COGS_SUM, accountCode: '1300', isRequired: false },
      { role: AccountingRole.COGS, side: MappingSide.CREDIT, amountSource: MappingAmountSource.LINE_COGS_SUM, accountCode: '5100', isRequired: false },
    ],
  },
  {
    event: AccountingEvent.PURCHASE_RETURN,
    lines: [
      { role: AccountingRole.ACCOUNTS_PAYABLE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '2100' },
      { role: AccountingRole.INVENTORY, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_NET, accountCode: '1300' },
      { role: AccountingRole.PURCHASE_TAX_RECEIVABLE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_TAX, accountCode: '1400', isRequired: false },
    ],
  },
  {
    event: AccountingEvent.OPENING_BALANCE,
    lines: [
      { role: AccountingRole.OPENING_EQUITY, side: MappingSide.CREDIT, amountSource: MappingAmountSource.OPENING_ROW, accountCode: '3100', isRequired: false },
    ],
  },
  {
    event: AccountingEvent.MANUAL,
    lines: [
      { role: AccountingRole.OTHER, side: MappingSide.DEBIT, amountSource: MappingAmountSource.CONTEXT, isRequired: false },
    ],
  },
  {
    event: AccountingEvent.DEPRECIATION,
    lines: [
      { role: AccountingRole.DEPRECIATION_EXPENSE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.CONTEXT, accountCode: '5300' },
      { role: AccountingRole.ACCUMULATED_DEPRECIATION, side: MappingSide.CREDIT, amountSource: MappingAmountSource.CONTEXT, accountCode: '1510' },
    ],
  },
  {
    event: AccountingEvent.PAYROLL_POST,
    lines: [
      { role: AccountingRole.PAYROLL_EXPENSE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.SALARY_AMOUNT, accountCode: '5210', isRequired: false },
      { role: AccountingRole.COMMISSION_EXPENSE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.COMMISSION_AMOUNT, accountCode: '5220', isRequired: false },
      { role: AccountingRole.SALARIES_PAYABLE, side: MappingSide.CREDIT, amountSource: MappingAmountSource.DOCUMENT_TOTAL, accountCode: '2300' },
    ],
  },
  {
    event: AccountingEvent.PAYROLL_PAYMENT,
    lines: [
      { role: AccountingRole.SALARIES_PAYABLE, side: MappingSide.DEBIT, amountSource: MappingAmountSource.TENDER_AMOUNT, accountCode: '2300' },
      { role: AccountingRole.CASH, side: MappingSide.CREDIT, amountSource: MappingAmountSource.TENDER_AMOUNT, accountCode: '1100', resolutionMode: AccountResolutionMode.CASH_ACCOUNT },
    ],
  },
];

export async function seedDefaultChartAndMappings(
  prisma: PrismaClient | Prisma.TransactionClient | PrismaService,
) {
  const codeToId = new Map<string, string>();
  for (const [index, seed] of SEED_ACCOUNTS.entries()) {
    const row = await prisma.account.upsert({
      where: { code: seed.code },
      create: {
        code: seed.code,
        name: seed.name,
        type: seed.type,
        normalBalance: seed.code === '1510' ? AccountNormalBalance.CREDIT : normalBalanceForType(seed.type),
        subledger: seed.subledger ?? AccountSubledger.NONE,
        isPostable: seed.isPostable ?? true,
        sortOrder: index * 10,
      },
      update: {
        name: seed.name,
        type: seed.type,
        subledger: seed.subledger ?? AccountSubledger.NONE,
        isActive: true,
      },
    });
    codeToId.set(seed.code, row.id);
  }

  for (const mapping of SEED_MAPPINGS) {
    const header = await prisma.accountMapping.upsert({
      where: { event: mapping.event },
      create: { event: mapping.event, isActive: true, notes: 'seed' },
      update: { isActive: true },
    });
    await prisma.accountMappingLine.deleteMany({ where: { mappingId: header.id } });
    for (const [order, line] of mapping.lines.entries()) {
      await prisma.accountMappingLine.create({
        data: {
          mappingId: header.id,
          role: line.role,
          side: line.side,
          amountSource: line.amountSource,
          resolutionMode: line.resolutionMode ?? AccountResolutionMode.FIXED,
          accountId: line.accountCode ? codeToId.get(line.accountCode) || null : null,
          isRequired: line.isRequired ?? true,
          lineOrder: order,
        },
      });
    }
  }

  return {
    accounts: await prisma.account.findMany({ orderBy: { code: 'asc' } }),
    mappings: await prisma.accountMapping.findMany({
      include: { lines: { orderBy: { lineOrder: 'asc' } } },
      orderBy: { event: 'asc' },
    }),
  };
}

@Injectable()
export class MappingService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async getMapping(event: AccountingEvent) {
    const mapping = await this.prisma.accountMapping.findUnique({
      where: { event },
      include: {
        lines: {
          include: { account: true },
          orderBy: { lineOrder: 'asc' },
        },
      },
    });
    if (!mapping) throw new NotFoundException('الربط المحاسبي غير موجود لهذا الحدث');
    return mapping;
  }

  async list() {
    return this.prisma.accountMapping.findMany({
      include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
      orderBy: { event: 'asc' },
    });
  }

  async upsertLines(event: AccountingEvent, lines: MappingLineInput[], userId?: string) {
    if (!Array.isArray(lines)) throw new BadRequestException('سطور الربط غير صالحة');
    const before = await this.prisma.accountMapping.findUnique({
      where: { event },
      include: { lines: true },
    });
    const mapping = await this.prisma.$transaction(async (tx) => {
      const header = await tx.accountMapping.upsert({
        where: { event },
        create: { event, isActive: true },
        update: {},
      });
      await tx.accountMappingLine.deleteMany({ where: { mappingId: header.id } });
      for (const [index, line] of lines.entries()) {
        if (!line.role || !line.side || !line.amountSource) {
          throw new BadRequestException('سطر الربط ناقص بيانات');
        }
        const mode = line.resolutionMode ?? AccountResolutionMode.FIXED;
        if (mode === AccountResolutionMode.FIXED && !line.accountId && (line.isRequired ?? true)) {
          throw new BadRequestException('الربط الثابت لازم يحدد حساب');
        }
        await tx.accountMappingLine.create({
          data: {
            mappingId: header.id,
            role: line.role,
            side: line.side,
            resolutionMode: mode,
            amountSource: line.amountSource,
            amountParam: line.amountParam ?? null,
            accountId: line.accountId || null,
            isRequired: line.isRequired ?? true,
            lineOrder: line.lineOrder ?? index,
            notes: line.notes?.trim() || null,
          },
        });
      }
      return tx.accountMapping.findUniqueOrThrow({
        where: { id: header.id },
        include: { lines: { include: { account: true }, orderBy: { lineOrder: 'asc' } } },
      });
    });
    await this.audit.log('MAPPING_UPSERT', 'AccountMapping', mapping.id, userId, before, mapping);
    return mapping;
  }

  async seed(userId?: string) {
    const result = await seedDefaultChartAndMappings(this.prisma);
    await this.audit.log('ACCOUNTING_SEED', 'AccountMapping', 'seed', userId, null, {
      accountCount: result.accounts.length,
      mappingCount: result.mappings.length,
    });
    return result;
  }
}
