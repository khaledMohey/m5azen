import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InvoiceStatus, PaymentMethod, Role } from '@prisma/client';
import { SalesService } from './sales.service';
import { Roles } from '../common/guards';

class LineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitPrice!: number;
  @IsOptional() @IsNumber() discount?: number;
}

class CreateSalesDto {
  @IsString() customerId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() invoiceDate?: string;
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsNumber() tax?: number;
  @IsOptional() @IsNumber() taxRate?: number;
  @IsOptional() @IsString() shiftId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumber() paidAmount?: number;
  @IsOptional() @IsString() cashAccountId?: string;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto)
  lines!: LineDto[];
}

@Controller('sales')
export class SalesController {
  constructor(private service: SalesService) {}

  @Get()
  findAll(@Query('status') status?: InvoiceStatus) {
    return this.service.findAll(status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  create(@Body() dto: CreateSalesDto, @Req() req: { user: { userId: string } }) {
    return this.service.create({ ...dto, createdById: req.user.userId });
  }

  @Post(':id/confirm')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  confirm(@Param('id') id: string, @Body() body: { cashAccountId?: string }) {
    return this.service.confirm(id, body.cashAccountId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  update(@Param('id') id: string, @Body() dto: CreateSalesDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
