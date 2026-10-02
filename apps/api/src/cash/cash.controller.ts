import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { CashDirection, PaymentMethod, Role } from '@prisma/client';
import { CashService } from './cash.service';
import { Roles } from '../common/guards';

class AccountDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsNumber() balance?: number;
  @IsOptional() @IsString() accountType?: string;
}

class TxDto {
  @IsString() accountId!: string;
  @IsEnum(CashDirection) direction!: CashDirection;
  @IsNumber() amount!: number;
  @IsString() description!: string;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
}

class ReceiptDto {
  @IsString() customerId!: string;
  @IsString() cashAccountId!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() salesInvoiceId?: string;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @IsOptional() @IsString() referenceNo?: string;
  @IsOptional() @IsString() note?: string;
}

class PaymentDto {
  @IsString() supplierId!: string;
  @IsString() cashAccountId!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() purchaseInvoiceId?: string;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @IsOptional() @IsString() referenceNo?: string;
  @IsOptional() @IsString() note?: string;
}

@Controller('cash')
export class CashController {
  constructor(private service: CashService) {}

  @Get('accounts')
  accounts() {
    return this.service.accounts();
  }

  @Post('accounts')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createAccount(@Body() dto: AccountDto) {
    return this.service.createAccount(dto);
  }

  @Patch('accounts/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateAccount(@Param('id') id: string, @Body() dto: Partial<AccountDto & { isActive: boolean }>) {
    return this.service.updateAccount(id, dto);
  }

  @Get('transactions')
  transactions(@Query('accountId') accountId?: string) {
    return this.service.transactions(accountId);
  }

  @Post('transactions')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createTx(@Body() dto: TxDto, @Req() req: { user: { userId: string } }) {
    return this.service.createTransaction({ ...dto, createdById: req.user.userId });
  }

  @Get('suppliers/:id/summary')
  supplierSummary(@Param('id') id: string) {
    return this.service.supplierSummary(id);
  }

  @Get('customers/:id/summary')
  customerSummary(@Param('id') id: string) {
    return this.service.customerSummary(id);
  }

  @Get('receipts')
  receipts() {
    return this.service.receipts();
  }

  @Post('receipts')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  createReceipt(@Body() dto: ReceiptDto) {
    return this.service.createReceipt(dto);
  }

  @Get('payments')
  payments() {
    return this.service.payments();
  }

  @Post('payments')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createPayment(@Body() dto: PaymentDto) {
    return this.service.createPayment(dto);
  }
}
