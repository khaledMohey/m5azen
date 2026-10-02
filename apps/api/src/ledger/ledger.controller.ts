import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsArray, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AccountType, Role } from '@prisma/client';
import { Roles } from '../common/guards';
import { LedgerService } from './ledger.service';

class AccountDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsEnum(AccountType) type!: AccountType;
}

class JournalLineDto {
  @IsString() accountId!: string;
  @IsOptional() @IsNumber() debit?: number;
  @IsOptional() @IsNumber() credit?: number;
  @IsOptional() @IsString() note?: string;
}

class JournalDto {
  @IsOptional() @IsString() entryDate?: string;
  @IsString() description!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

@Controller('ledger')
export class LedgerController {
  constructor(private service: LedgerService) {}

  @Get('accounts')
  accounts() {
    return this.service.listAccounts();
  }

  @Post('accounts')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createAccount(@Body() dto: AccountDto) {
    return this.service.createAccount(dto);
  }

  @Post('accounts/seed')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  seed() {
    return this.service.seedDefaults();
  }

  @Get('entries')
  entries() {
    return this.service.listEntries();
  }

  @Post('entries')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createEntry(@Body() dto: JournalDto) {
    return this.service.createEntry(dto);
  }
}
