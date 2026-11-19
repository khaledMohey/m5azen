import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { normalizeAccess } from '../common/access-map';
import { PrismaService } from '../prisma/prisma.service';
import { egyptDayKey } from './egypt-time';

@Injectable()
export class EmployeesService {
  constructor(private prisma: PrismaService) {}

  list(activeOnly = false) {
    return this.prisma.employee.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      include: {
        user: { select: { id: true, username: true, fullName: true, role: true, isActive: true, permissions: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async nextCode() {
    const rows = await this.prisma.employee.findMany({ select: { code: true } });
    let max = 0;
    for (const row of rows) {
      const n = Number((row.code || '').replace(/\D/g, ''));
      if (n > max) max = n;
    }
    return `EMP-${String(max + 1).padStart(4, '0')}`;
  }

  async findOne(id: string) {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true, username: true, fullName: true, role: true, isActive: true, permissions: true,
            warehouseLinks: { select: { warehouseId: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('الموظف غير موجود');
    return row;
  }

  async me(userId: string) {
    return this.prisma.employee.findUnique({
      where: { userId },
      include: { user: { select: { id: true, username: true, fullName: true, role: true } } },
    });
  }

  linkableUsers(exceptEmployeeId?: string) {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { employee: null },
          ...(exceptEmployeeId ? [{ employee: { id: exceptEmployeeId } }] : []),
        ],
      },
      select: { id: true, username: true, fullName: true, role: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async create(data: {
    code?: string;
    name: string;
    phone?: string;
    nationalId?: string;
    jobTitle?: string;
    department?: string;
    hireDate?: string;
    basicSalary?: number;
    commissionPercent?: number;
    userId?: string | null;
    bankAccount?: string;
    notes?: string;
  }) {
    const code = (data.code?.trim() || await this.nextCode());
    if (!data.name?.trim()) throw new BadRequestException('اسم الموظف مطلوب');
    if (data.userId) await this.assertUserFree(data.userId);
    return this.prisma.employee.create({
      data: {
        code,
        name: data.name.trim(),
        phone: data.phone?.trim() || null,
        nationalId: data.nationalId?.trim() || null,
        jobTitle: data.jobTitle?.trim() || null,
        department: data.department?.trim() || null,
        hireDate: data.hireDate ? new Date(`${egyptDayKey(data.hireDate)}T12:00:00+02:00`) : null,
        basicSalary: data.basicSalary || 0,
        commissionPercent: data.commissionPercent || 0,
        userId: data.userId || null,
        bankAccount: data.bankAccount?.trim() || null,
        notes: data.notes?.trim() || null,
      },
      include: { user: { select: { id: true, username: true, fullName: true, role: true } } },
    });
  }

  async update(id: string, data: Partial<{
    code: string; name: string; phone: string; nationalId: string; jobTitle: string; department: string;
    hireDate: string | null; basicSalary: number; commissionPercent: number; userId: string | null;
    bankAccount: string; notes: string; isActive: boolean;
  }>) {
    const current = await this.findOne(id);
    if (data.userId && data.userId !== current.userId) await this.assertUserFree(data.userId, id);
    return this.prisma.employee.update({
      where: { id },
      data: {
        code: data.code?.trim(),
        name: data.name?.trim(),
        phone: data.phone === undefined ? undefined : (data.phone?.trim() || null),
        nationalId: data.nationalId === undefined ? undefined : (data.nationalId?.trim() || null),
        jobTitle: data.jobTitle === undefined ? undefined : (data.jobTitle?.trim() || null),
        department: data.department === undefined ? undefined : (data.department?.trim() || null),
        hireDate: data.hireDate === undefined
          ? undefined
          : (data.hireDate ? new Date(`${egyptDayKey(data.hireDate)}T12:00:00+02:00`) : null),
        basicSalary: data.basicSalary,
        commissionPercent: data.commissionPercent,
        userId: data.userId === undefined ? undefined : data.userId,
        bankAccount: data.bankAccount === undefined ? undefined : (data.bankAccount?.trim() || null),
        notes: data.notes === undefined ? undefined : (data.notes?.trim() || null),
        isActive: data.isActive,
      },
      include: { user: { select: { id: true, username: true, fullName: true, role: true, isActive: true, permissions: true } } },
    });
  }

  async createAccount(
    employeeId: string,
    data: {
      username: string;
      password: string;
      fullName?: string;
      role?: Role;
      warehouseIds?: string[];
      permissions?: Record<string, unknown>;
    },
  ) {
    const employee = await this.findOne(employeeId);
    if (employee.userId) throw new BadRequestException('الموظف مربوط بحساب بالفعل');
    const username = data.username.trim();
    if (!username || !data.password) throw new BadRequestException('اسم الدخول وكلمة السر مطلوبين');
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) throw new ConflictException('اسم المستخدم موجود مسبقاً');
    const role = data.role || Role.SALES;
    const permissions = data.permissions
      ? JSON.stringify(normalizeAccess(data.permissions, role))
      : null;
    const passwordHash = await bcrypt.hash(data.password, 10);
    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        fullName: (data.fullName || employee.name).trim(),
        role,
        permissions,
      },
    });
    if (data.warehouseIds?.length) {
      await this.prisma.userWarehouse.createMany({
        data: data.warehouseIds.map((warehouseId) => ({ userId: user.id, warehouseId })),
      });
    }
    return this.prisma.employee.update({
      where: { id: employeeId },
      data: { userId: user.id },
      include: {
        user: {
          select: {
            id: true, username: true, fullName: true, role: true, isActive: true, permissions: true,
            warehouseLinks: { select: { warehouseId: true } },
          },
        },
      },
    });
  }

  async updateAccount(
    employeeId: string,
    data: {
      password?: string;
      fullName?: string;
      role?: Role;
      isActive?: boolean;
      warehouseIds?: string[];
      permissions?: Record<string, unknown>;
    },
  ) {
    const employee = await this.findOne(employeeId);
    if (!employee.userId || !employee.user) throw new BadRequestException('الموظف مش مربوط بحساب');
    const role = data.role || employee.user.role;
    const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : undefined;
    const permissions = data.permissions
      ? JSON.stringify(normalizeAccess(data.permissions, role))
      : undefined;
    await this.prisma.user.update({
      where: { id: employee.userId },
      data: {
        fullName: data.fullName?.trim(),
        role: data.role,
        isActive: data.isActive,
        ...(passwordHash ? { passwordHash } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
      },
    });
    if (data.warehouseIds) {
      await this.prisma.userWarehouse.deleteMany({ where: { userId: employee.userId } });
      if (data.warehouseIds.length) {
        await this.prisma.userWarehouse.createMany({
          data: data.warehouseIds.map((warehouseId) => ({ userId: employee.userId!, warehouseId })),
        });
      }
    }
    return this.findOne(employeeId);
  }

  private async assertUserFree(userId: string, exceptEmployeeId?: string) {
    const linked = await this.prisma.employee.findFirst({
      where: { userId, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) },
    });
    if (linked) throw new BadRequestException('الحساب مربوط بموظف آخر');
  }
}
