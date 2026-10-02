import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '@prisma/client';
import { StockService } from './stock.service';
import { Roles } from '../common/guards';

class TransferLineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
}

class TransferDto {
  @IsString() fromWarehouseId!: string;
  @IsString() toWarehouseId!: string;
  @IsOptional() @IsString() note?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => TransferLineDto)
  lines!: TransferLineDto[];
}

class UpdateMovementDto {
  @IsOptional() @IsNumber() quantity?: number;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() reference?: string;
}

class UpdateBatchDto {
  @IsOptional() @IsString() batchNumber?: string;
  @IsOptional() @IsString() expiryDate?: string;
  @IsOptional() @IsNumber() unitCost?: number;
}

@Controller('stock')
export class StockController {
  constructor(private service: StockService) {}

  @Get('balances')
  balances(
    @Query('warehouseId') warehouseId?: string,
    @Query('search') search?: string,
  ) {
    return this.service.balances(warehouseId, search);
  }

  @Get('valuation')
  valuation(
    @Query('warehouseId') warehouseId?: string,
    @Query('search') search?: string,
  ) {
    return this.service.valuation(warehouseId, search);
  }

  @Get('movements')
  movements(
    @Query('warehouseId') warehouseId?: string,
    @Query('productId') productId?: string,
    @Query('search') search?: string,
  ) {
    return this.service.movements({ warehouseId, productId, search });
  }

  @Patch('movements/:id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  updateMovement(@Param('id') id: string, @Body() dto: UpdateMovementDto) {
    return this.service.updateMovement(id, dto);
  }

  @Delete('movements/:id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  deleteMovement(@Param('id') id: string) {
    return this.service.deleteMovement(id);
  }

  @Patch('batches/:lineId')
  @Roles(Role.ADMIN, Role.WAREHOUSE, Role.ACCOUNTANT)
  updateBatch(@Param('lineId') lineId: string, @Body() dto: UpdateBatchDto) {
    return this.service.updatePurchaseBatch(lineId, dto);
  }

  @Delete('batches/:lineId')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  deleteBatch(@Param('lineId') lineId: string) {
    return this.service.deletePurchaseBatch(lineId);
  }

  @Get('low')
  lowStock() {
    return this.service.lowStock();
  }

  @Get('transfers')
  transfers() {
    return this.service.listTransfers();
  }

  @Post('transfers')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  transfer(@Body() dto: TransferDto) {
    return this.service.transfer(dto);
  }

  @Post('adjustments')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  adjust(@Body() dto: { warehouseId: string; note?: string; mode: 'set' | 'delta'; lines: { productId: string; quantity: number }[] }) {
    return this.service.adjust(dto);
  }

  @Get('expiry')
  expiry(@Query('days') days?: string) {
    return this.service.expiring(days ? Number(days) : 30);
  }

  @Get('locations')
  locations(@Query('warehouseId') warehouseId: string) {
    return this.service.listLocations(warehouseId);
  }

  @Post('locations')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  createLocation(@Body() dto: { warehouseId: string; code: string; name: string }) {
    return this.service.createLocation(dto);
  }

  @Delete('locations/:id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  removeLocation(@Param('id') id: string) {
    return this.service.removeLocation(id);
  }

  @Get('product-locations')
  productLocations(@Query('warehouseId') warehouseId?: string) {
    return this.service.listProductLocations(warehouseId);
  }

  @Post('product-locations')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  assignLocation(@Body() dto: { productId: string; warehouseId: string; locationId: string }) {
    return this.service.assignLocation(dto);
  }
}
