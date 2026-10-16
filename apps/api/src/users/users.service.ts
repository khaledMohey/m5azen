import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      select: { id: true, username: true, fullName: true, role: true, isActive: true, createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(data: { username: string; password: string; fullName: string; role: Role }) {
    const exists = await this.prisma.user.findUnique({ where: { username: data.username } });
    if (exists) throw new ConflictException('اسم المستخدم موجود مسبقاً');
    const passwordHash = await bcrypt.hash(data.password, 10);
    return this.prisma.user.create({
      data: {
        username: data.username,
        passwordHash,
        fullName: data.fullName,
        role: data.role,
      },
      select: { id: true, username: true, fullName: true, role: true, isActive: true },
    });
  }

  async update(
    id: string,
    data: { fullName?: string; role?: Role; isActive?: boolean; password?: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : undefined;
    return this.prisma.user.update({
      where: { id },
      data: {
        fullName: data.fullName,
        role: data.role,
        isActive: data.isActive,
        ...(passwordHash ? { passwordHash } : {}),
      },
      select: { id: true, username: true, fullName: true, role: true, isActive: true },
    });
  }

  warehouses(userId: string) {
    return this.prisma.userWarehouse.findMany({
      where: { userId },
      include: { warehouse: true },
    });
  }

  async setWarehouses(userId: string, warehouseIds: string[]) {
    await this.prisma.userWarehouse.deleteMany({ where: { userId } });
    if (warehouseIds.length) {
      await this.prisma.userWarehouse.createMany({
        data: warehouseIds.map((warehouseId) => ({ userId, warehouseId })),
      });
    }
    return this.warehouses(userId);
  }
}
