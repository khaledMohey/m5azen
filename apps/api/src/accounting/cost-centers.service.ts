import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

export type CostCenterInput = {
  code: string;
  name: string;
  isActive?: boolean;
};

@Injectable()
export class CostCentersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async list(activeOnly = false) {
    return this.prisma.costCenter.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: [{ code: 'asc' }],
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.costCenter.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('مركز التكلفة غير موجود');
    return row;
  }

  async create(data: CostCenterInput, userId?: string) {
    const code = data.code?.trim();
    const name = data.name?.trim();
    if (!code) throw new BadRequestException('أدخل كود مركز التكلفة');
    if (!name) throw new BadRequestException('أدخل اسم مركز التكلفة');
    const existing = await this.prisma.costCenter.findUnique({ where: { code } });
    if (existing) throw new BadRequestException('كود مركز التكلفة مستخدم قبل كده');

    const row = await this.prisma.costCenter.create({
      data: {
        code,
        name,
        isActive: data.isActive ?? true,
      },
    });
    await this.audit.log('COST_CENTER_CREATE', 'CostCenter', row.id, userId, null, row);
    return row;
  }

  async update(id: string, data: Partial<CostCenterInput>, userId?: string) {
    const existing = await this.findOne(id);
    if (data.code && data.code.trim() !== existing.code) {
      const clash = await this.prisma.costCenter.findUnique({ where: { code: data.code.trim() } });
      if (clash) throw new BadRequestException('كود مركز التكلفة مستخدم قبل كده');
    }
    const row = await this.prisma.costCenter.update({
      where: { id },
      data: {
        code: data.code?.trim(),
        name: data.name?.trim(),
        isActive: data.isActive,
      },
    });
    await this.audit.log('COST_CENTER_UPDATE', 'CostCenter', id, userId, existing, row);
    return row;
  }
}
