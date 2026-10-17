import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InvoiceStatus, Role } from '@prisma/client';
import { PurchasesService } from './purchases.service';
import { Roles } from '../common/guards';

class LineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitCost!: number;
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsString() batchNumber?: string;
  @IsOptional() @IsString() expiryDate?: string;
}

class TenderDto {
  @IsString() methodId!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() referenceNo?: string;
}

class CreatePurchaseDto {
  @IsString() supplierId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() invoiceDate?: string;
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsNumber() tax?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumber() paidAmount?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TenderDto) payments?: TenderDto[];
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto)
  lines!: LineDto[];
}

@Controller('purchases')
export class PurchasesController {
  constructor(private service: PurchasesService) {}

  @Get()
  findAll(@Query('status') status?: InvoiceStatus) {
    return this.service.findAll(status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  create(@Body() dto: CreatePurchaseDto, @Req() req: { user: { userId: string } }) {
    return this.service.create({ ...dto, createdById: req.user.userId });
  }

  @Post(':id/confirm')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  confirm(@Param('id') id: string, @Body() body: { payments?: TenderDto[] }) {
    return this.service.confirm(id, body.payments);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  update(@Param('id') id: string, @Body() dto: CreatePurchaseDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
