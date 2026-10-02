import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  async findAll(user?: { userId: string; role: string }) {
    const all = () => this.prisma.warehouse.findMany({ orderBy: { name: 'asc' } });
    if (!user || user.role === 'ADMIN') return all();
    const links = await this.prisma.userWarehouse.findMany({ where: { userId: user.userId } });
    if (!links.length) return all();
    return this.prisma.warehouse.findMany({
      where: { id: { in: links.map((l) => l.warehouseId) } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!wh) throw new NotFoundException('المخزن غير موجود');
    return wh;
  }

  create(data: { code: string; name: string; location?: string; description?: string }) {
    return this.prisma.warehouse.create({ data });
  }

  update(
    id: string,
    data: Partial<{ code: string; name: string; location: string; description: string; isActive: boolean }>,
  ) {
    return this.prisma.warehouse.update({ where: { id }, data });
  }

  async remove(id: string) {
    const balances = await this.prisma.stockBalance.count({
      where: { warehouseId: id, quantity: { not: 0 } },
    });
    if (balances > 0) {
      throw new BadRequestException('لا يمكن حذف مخزن به أرصدة');
    }
    return this.prisma.warehouse.delete({ where: { id } });
  }
}
