import { Injectable, NotFoundException } from '@nestjs/common';
import { FieldType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  listFields() {
    return this.prisma.productCustomField.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  createField(data: {
    name: string;
    label: string;
    fieldType?: FieldType;
    options?: string;
    isRequired?: boolean;
    sortOrder?: number;
  }) {
    return this.prisma.productCustomField.create({
      data: {
        name: data.name,
        label: data.label,
        fieldType: data.fieldType || FieldType.TEXT,
        options: data.options,
        isRequired: data.isRequired ?? false,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  }

  updateField(
    id: string,
    data: Partial<{
      label: string;
      fieldType: FieldType;
      options: string;
      isRequired: boolean;
      sortOrder: number;
    }>,
  ) {
    return this.prisma.productCustomField.update({ where: { id }, data });
  }

  async deleteField(id: string) {
    await this.prisma.productFieldValue.deleteMany({ where: { fieldId: id } });
    return this.prisma.productCustomField.delete({ where: { id } });
  }

  findAll(search?: string) {
    return this.prisma.product.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search } },
              { sku: { contains: search } },
              { barcode: { contains: search } },
              { brand: { contains: search } },
            ],
          }
        : undefined,
      include: {
        category: true,
        fieldValues: { include: { field: true } },
        stockBalances: { include: { warehouse: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        fieldValues: { include: { field: true } },
        stockBalances: { include: { warehouse: true } },
      },
    });
    if (!product) throw new NotFoundException('الصنف غير موجود');
    return product;
  }

  async create(data: {
    sku: string;
    name: string;
    unit?: string;
    costPrice?: number;
    salePrice?: number;
    minStock?: number;
    description?: string;
    barcode?: string | null;
    brand?: string | null;
    categoryId?: string | null;
    wholesalePrice?: number;
    packUnit?: string | null;
    packSize?: number;
    fieldValues?: { fieldId: string; value: string }[];
  }) {
    const { fieldValues, ...rest } = data;
    rest.barcode = rest.barcode?.trim() || null;
    rest.brand = rest.brand?.trim() || null;
    rest.categoryId = rest.categoryId || null;
    rest.packUnit = rest.packUnit?.trim() || null;
    const cleaned = (fieldValues || []).filter((fv) => fv.value?.trim());
    return this.prisma.product.create({
      data: {
        ...rest,
        fieldValues: cleaned.length ? { create: cleaned } : undefined,
      },
      include: {
        fieldValues: { include: { field: true } },
        stockBalances: true,
      },
    });
  }

  async update(
    id: string,
    data: {
      sku?: string;
      name?: string;
      unit?: string;
      salePrice?: number;
      minStock?: number;
      description?: string;
      isActive?: boolean;
      barcode?: string | null;
      brand?: string | null;
      categoryId?: string | null;
      wholesalePrice?: number;
      packUnit?: string | null;
      packSize?: number;
      fieldValues?: { fieldId: string; value: string }[];
    },
  ) {
    const { fieldValues, ...rest } = data;
    if (rest.barcode !== undefined) rest.barcode = rest.barcode?.trim() || null;
    if (rest.brand !== undefined) rest.brand = rest.brand?.trim() || null;
    if (rest.categoryId !== undefined) rest.categoryId = rest.categoryId || null;
    if (rest.packUnit !== undefined) rest.packUnit = rest.packUnit?.trim() || null;
    if (fieldValues) {
      await this.prisma.productFieldValue.deleteMany({ where: { productId: id } });
      const cleaned = fieldValues.filter((fv) => fv.value?.trim());
      if (cleaned.length) {
        await this.prisma.productFieldValue.createMany({
          data: cleaned.map((fv) => ({ ...fv, productId: id })),
        });
      }
    }
    return this.prisma.product.update({
      where: { id },
      data: rest,
      include: {
        fieldValues: { include: { field: true } },
        stockBalances: true,
      },
    });
  }

  listCategories() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } });
  }

  createCategory(name: string) {
    return this.prisma.category.create({ data: { name: name.trim() } });
  }

  deleteCategory(id: string) {
    return this.prisma.category.delete({ where: { id } });
  }

  async findByBarcode(code: string) {
    const product = await this.prisma.product.findFirst({
      where: { OR: [{ barcode: code }, { sku: code }] },
      include: { category: true, customerPrices: true },
    });
    if (!product) throw new NotFoundException('لا يوجد صنف بهذا الباركود');
    return product;
  }
}
