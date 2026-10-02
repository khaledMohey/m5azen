import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { CheckDirection, CheckStatus, PaymentMethod, Role } from '@prisma/client';
import { Roles } from '../common/guards';
import { FinanceService } from './finance.service';

class OpenShiftDto {
  @IsString() cashAccountId!: string;
  @IsNumber() openingCash!: number;
  @IsOptional() @IsString() notes?: string;
}

class CloseShiftDto {
  @IsNumber() closingCash!: number;
  @IsOptional() @IsString() notes?: string;
}

class ExpenseDto {
  @IsString() categoryId!: string;
  @IsString() accountId!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() expenseDate?: string;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() shiftId?: string;
}

class CheckDto {
  @IsEnum(CheckDirection) direction!: CheckDirection;
  @IsString() checkNumber!: string;
  @IsString() bankName!: string;
  @IsNumber() amount!: number;
  @IsString() dueDate!: string;
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() notes?: string;
}

@Controller('finance')
export class FinanceController {
  constructor(private service: FinanceService) {}

  @Get('shifts')
  shifts() {
    return this.service.listShifts();
  }

  @Get('shifts/current')
  current(@Req() req: { user: { userId: string } }) {
    return this.service.currentShift(req.user.userId);
  }

  @Post('shifts')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  open(@Body() dto: OpenShiftDto, @Req() req: { user: { userId: string } }) {
    return this.service.openShift({ ...dto, userId: req.user.userId });
  }

  @Post('shifts/:id/close')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  close(@Param('id') id: string, @Body() dto: CloseShiftDto) {
    return this.service.closeShift(id, dto);
  }

  @Get('expense-categories')
  expenseCategories() {
    return this.service.listExpenseCategories();
  }

  @Post('expense-categories')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createCategory(@Body() body: { name: string }) {
    return this.service.createExpenseCategory(body.name);
  }

  @Get('expenses')
  expenses() {
    return this.service.listExpenses();
  }

  @Post('expenses')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createExpense(@Body() dto: ExpenseDto) {
    return this.service.createExpense(dto);
  }

  @Get('checks')
  checks() {
    return this.service.listChecks();
  }

  @Post('checks')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createCheck(@Body() dto: CheckDto) {
    return this.service.createCheck(dto);
  }

  @Patch('checks/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  setCheck(@Param('id') id: string, @Body() body: { status: CheckStatus; accountId?: string }) {
    return this.service.setCheckStatus(id, body.status, body.accountId);
  }
}
