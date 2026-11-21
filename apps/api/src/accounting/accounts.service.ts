import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountSubledger, AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalBalanceForType } from './party';
import { AuditService } from './audit.service';

export type AccountInput = {
  code: string;
  name: string;
  type: AccountType;
  parentId?: string | null;
  isPostable?: boolean;
  isActive?: boolean;
  cashAccountId?: string | null;
  subledger?: AccountSubledger;
  sortOrder?: number;
  costCenterId?: string | null;
  notes?: string | null;
};

@Injectable()
export class AccountsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private async assertParent(type: AccountType, parentId?: string | null, selfId?: string) {
    if (!parentId) return null;
    const parent = await this.prisma.account.findUnique({ where: { id: parentId } });
    if (!parent) throw new BadRequestException('الحساب الأب غير موجود');
    if (parent.type !== type) {
      throw new BadRequestException('نوع الحساب لازم يطابق نوع الحساب الأب');
    }
    if (selfId) {
      let cursor: string | null = parentId;
      const seen = new Set<string>([selfId]);
      while (cursor) {
        if (seen.has(cursor)) throw new BadRequestException('هيكل الحسابات فيه دورة — اختار أب تاني');
        seen.add(cursor);
        const row: { parentId: string | null } | null = await this.prisma.account.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
        cursor = row?.parentId || null;
      }
    }
    return parent;
  }

  async create(data: AccountInput, userId?: string) {
    const code = data.code?.trim();
    const name = data.name?.trim();
    if (!code) throw new BadRequestException('أدخل كود الحساب');
    if (!name) throw new BadRequestException('أدخل اسم الحساب');
    if (!data.type) throw new BadRequestException('اختار نوع الحساب');
    await this.assertParent(data.type, data.parentId);
    const existing = await this.prisma.account.findUnique({ where: { code } });
    if (existing) throw new BadRequestException('كود الحساب مستخدم قبل كده');

    const row = await this.prisma.account.create({
      data: {
        code,
        name,
        type: data.type,
        parentId: data.parentId || null,
        isPostable: data.isPostable ?? true,
        isActive: data.isActive ?? true,
        cashAccountId: data.cashAccountId || null,
        normalBalance: normalBalanceForType(data.type),
        subledger: data.subledger ?? AccountSubledger.NONE,
        sortOrder: data.sortOrder ?? 0,
        costCenterId: data.costCenterId || null,
        notes: data.notes?.trim() || null,
      },
    });
    await this.audit.log('ACCOUNT_CREATE', 'Account', row.id, userId, null, row);
    return row;
  }

  async update(id: string, data: Partial<AccountInput>, userId?: string) {
    const existing = await this.prisma.account.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الحساب غير موجود');
    const type = data.type ?? existing.type;
    const parentId = data.parentId === undefined ? existing.parentId : data.parentId;
    if (parentId === id) throw new BadRequestException('الحساب مش ينفع يكون أب لنفسه');
    await this.assertParent(type, parentId, id);

    if (data.code && data.code.trim() !== existing.code) {
      const clash = await this.prisma.account.findUnique({ where: { code: data.code.trim() } });
      if (clash) throw new BadRequestException('كود الحساب مستخدم قبل كده');
    }

    const row = await this.prisma.account.update({
      where: { id },
      data: {
        code: data.code?.trim(),
        name: data.name?.trim(),
        type: data.type,
        parentId,
        isPostable: data.isPostable,
        isActive: data.isActive,
        cashAccountId: data.cashAccountId === undefined ? undefined : data.cashAccountId || null,
        normalBalance: data.type ? normalBalanceForType(data.type) : undefined,
        subledger: data.subledger,
        sortOrder: data.sortOrder,
        costCenterId: data.costCenterId === undefined ? undefined : data.costCenterId || null,
        notes: data.notes === undefined ? undefined : data.notes?.trim() || null,
      },
    });
    await this.audit.log('ACCOUNT_UPDATE', 'Account', id, userId, existing, row);
    return row;
  }

  async remove(id: string, userId?: string) {
    const existing = await this.prisma.account.findUnique({
      where: { id },
      include: { _count: { select: { children: true, journalLines: true, mappingLines: true, openingBalances: true } } },
    });
    if (!existing) throw new NotFoundException('الحساب غير موجود');
    if (existing._count.children > 0) throw new BadRequestException('الحساب عليه حسابات فرعية');
    if (existing._count.journalLines > 0) throw new BadRequestException('الحساب مستخدم في قيود');
    if (existing._count.mappingLines > 0) throw new BadRequestException('الحساب مربوط بربط محاسبي');
    if (existing._count.openingBalances > 0) throw new BadRequestException('الحساب عليه أرصدة افتتاحية');
    await this.prisma.account.delete({ where: { id } });
    await this.audit.log('ACCOUNT_DELETE', 'Account', id, userId, existing, null);
    return { ok: true };
  }

  async findOne(id: string) {
    const row = await this.prisma.account.findUnique({
      where: { id },
      include: { parent: true, children: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
    });
    if (!row) throw new NotFoundException('الحساب غير موجود');
    return row;
  }

  async list(filters: { type?: AccountType; activeOnly?: boolean; q?: string } = {}) {
    const where: Prisma.AccountWhereInput = {};
    if (filters.type) where.type = filters.type;
    if (filters.activeOnly) where.isActive = true;
    if (filters.q?.trim()) {
      const q = filters.q.trim();
      where.OR = [{ code: { contains: q } }, { name: { contains: q } }];
    }
    return this.prisma.account.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async tree(activeOnly = false) {
    const rows = await this.list({ activeOnly });
    type Node = (typeof rows)[number] & { children: Node[] };
    const map = new Map<string, Node>();
    for (const row of rows) map.set(row.id, { ...row, children: [] });
    const roots: Node[] = [];
    for (const node of map.values()) {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }
}
