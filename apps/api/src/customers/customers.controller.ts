import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { PriceList, Role } from '@prisma/client';
import { CustomersService } from './customers.service';
import { Roles } from '../common/guards';

class CustomerDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsNumber() creditLimit?: number;
  @IsOptional() @IsEnum(PriceList) priceList?: PriceList;
  @IsOptional() @IsString() notes?: string;
}

class BulkCustomerDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
  @IsBoolean() isActive!: boolean;
}

class UpdateCustomerDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsNumber() creditLimit?: number;
  @IsOptional() @IsEnum(PriceList) priceList?: PriceList;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('customers')
export class CustomersController {
  constructor(private service: CustomersService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.service.findAll(search);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/statement')
  statement(@Param('id') id: string) {
    return this.service.statement(id);
  }

  @Get(':id/prices')
  prices(@Param('id') id: string) {
    return this.service.listPrices(id);
  }

  @Put(':id/prices')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  setPrices(@Param('id') id: string, @Body() body: { prices: { productId: string; price: number }[] }) {
    return this.service.setPrices(id, body.prices || []);
  }

  @Post('bulk')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  bulk(@Body() dto: BulkCustomerDto) {
    return this.service.bulkSetActive(dto.ids, dto.isActive);
  }

  @Post()
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  create(@Body() dto: CustomerDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.service.update(id, dto);
  }
}
