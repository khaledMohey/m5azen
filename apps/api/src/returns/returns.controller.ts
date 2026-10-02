import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '@prisma/client';
import { ReturnsService } from './returns.service';
import { Roles } from '../common/guards';

class SalesReturnLineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitPrice!: number;
}

class CreateSalesReturnDto {
  @IsString() customerId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() salesInvoiceId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SalesReturnLineDto)
  lines!: SalesReturnLineDto[];
}

class PurchaseReturnLineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitCost!: number;
}

class CreatePurchaseReturnDto {
  @IsString() supplierId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() purchaseInvoiceId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PurchaseReturnLineDto)
  lines!: PurchaseReturnLineDto[];
}

@Controller('returns')
export class ReturnsController {
  constructor(private service: ReturnsService) {}

  @Get('sales')
  listSales() {
    return this.service.listSalesReturns();
  }

  @Get('purchases')
  listPurchases() {
    return this.service.listPurchaseReturns();
  }

  @Get('sales/returnable/:customerId')
  salesReturnable(@Param('customerId') customerId: string) {
    return this.service.salesReturnable(customerId);
  }

  @Get('purchases/returnable/:supplierId')
  purchasesReturnable(@Param('supplierId') supplierId: string) {
    return this.service.purchasesReturnable(supplierId);
  }

  @Post('sales')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  createSales(@Body() dto: CreateSalesReturnDto) {
    return this.service.createSalesReturn(dto);
  }

  @Post('purchases')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  createPurchase(@Body() dto: CreatePurchaseReturnDto) {
    return this.service.createPurchaseReturn(dto);
  }
}
