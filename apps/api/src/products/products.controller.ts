import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FieldType, Role } from '@prisma/client';
import { ProductsService } from './products.service';
import { Roles } from '../common/guards';

class FieldValueDto {
  @IsString() fieldId!: string;
  @IsString() value!: string;
}

class ProductFieldDto {
  @IsString() name!: string;
  @IsString() label!: string;
  @IsOptional() @IsEnum(FieldType) fieldType?: FieldType;
  @IsOptional() @IsString() options?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

class UpdateProductFieldDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsEnum(FieldType) fieldType?: FieldType;
  @IsOptional() @IsString() options?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

class ProductDto {
  @IsString() sku!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() costPrice?: number;
  @IsOptional() @IsNumber() salePrice?: number;
  @IsOptional() @IsNumber() wholesalePrice?: number;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsNumber() packSize?: number;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() packUnit?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FieldValueDto)
  fieldValues?: FieldValueDto[];
}

class UpdateProductDto {
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() salePrice?: number;
  @IsOptional() @IsNumber() wholesalePrice?: number;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsNumber() packSize?: number;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() packUnit?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FieldValueDto)
  fieldValues?: FieldValueDto[];
}

@Controller('products')
export class ProductsController {
  constructor(private service: ProductsService) {}

  @Get('fields')
  listFields() {
    return this.service.listFields();
  }

  @Post('fields')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  createField(@Body() dto: ProductFieldDto) {
    return this.service.createField(dto);
  }

  @Patch('fields/:fieldId')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  updateField(@Param('fieldId') fieldId: string, @Body() dto: UpdateProductFieldDto) {
    return this.service.updateField(fieldId, dto);
  }

  @Delete('fields/:fieldId')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  deleteField(@Param('fieldId') fieldId: string) {
    return this.service.deleteField(fieldId);
  }

  @Get('categories')
  categories() {
    return this.service.listCategories();
  }

  @Post('categories')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  createCategory(@Body() body: { name: string }) {
    return this.service.createCategory(body.name);
  }

  @Delete('categories/:id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  deleteCategory(@Param('id') id: string) {
    return this.service.deleteCategory(id);
  }

  @Get('barcode/:code')
  barcode(@Param('code') code: string) {
    return this.service.findByBarcode(code);
  }

  @Get()
  findAll(@Query('search') search?: string) {
    return this.service.findAll(search);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  create(@Body() dto: ProductDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.service.update(id, dto);
  }
}
