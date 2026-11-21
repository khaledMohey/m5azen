import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  AccountSubledger,
  AccountType,
  AccountingEvent,
  AccountingPartyType,
  AccountingPostQueueStatus,
  AccountingRole,
  AccountResolutionMode,
  JournalEntryStatus,
  MappingAmountSource,
  MappingSide,
  Role,
} from '@prisma/client';
import { Roles } from '../common/guards';
import { AccountsService } from './accounts.service';
import { JournalService } from './journal.service';
import { OpeningService } from './opening.service';
import { MappingService } from './mapping.service';
import { AccountingReportsService } from './reports.service';
import { QueueService } from './queue.service';
import { PostingService } from './posting.service';
import { CogsReconcileService } from './cogs-reconcile.service';
import { DepreciationService } from './depreciation.service';
import { ClosingService } from './closing.service';
import { CostCentersService } from './cost-centers.service';
import { ReconciliationService } from './reconciliation.service';

class JournalLineDto {
  @IsString() accountId!: string;
  @IsOptional() @IsNumber() debit?: number;
  @IsOptional() @IsNumber() credit?: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(AccountingPartyType) partyType?: AccountingPartyType;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() costCenterId?: string;
  @IsOptional() @IsNumber() lineOrder?: number;
}

class JournalDraftDto {
  @IsString() entryDate!: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

class JournalReverseDto {
  @IsOptional() @IsString() entryDate?: string;
  @IsOptional() @IsString() reason?: string;
}

class AccountDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsEnum(AccountType) type!: AccountType;
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() cashAccountId?: string;
  @IsOptional() @IsEnum(AccountSubledger) subledger?: AccountSubledger;
  @IsOptional() @IsNumber() sortOrder?: number;
  @IsOptional() @IsString() costCenterId?: string;
  @IsOptional() @IsString() notes?: string;
}

class AccountUpdateDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(AccountType) type?: AccountType;
  @IsOptional() @IsString() parentId?: string | null;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() cashAccountId?: string | null;
  @IsOptional() @IsEnum(AccountSubledger) subledger?: AccountSubledger;
  @IsOptional() @IsNumber() sortOrder?: number;
  @IsOptional() @IsString() costCenterId?: string | null;
  @IsOptional() @IsString() notes?: string | null;
}

class OpeningBatchDto {
  @IsNumber() year!: number;
  @IsOptional() @IsString() notes?: string;
}

class OpeningLineDto {
  @IsString() accountId!: string;
  @IsOptional() @IsNumber() debit?: number;
  @IsOptional() @IsNumber() credit?: number;
  @IsOptional() @IsEnum(AccountingPartyType) partyType?: AccountingPartyType;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() notes?: string;
}

class MappingLineDto {
  @IsEnum(AccountingRole) role!: AccountingRole;
  @IsEnum(MappingSide) side!: MappingSide;
  @IsOptional() @IsEnum(AccountResolutionMode) resolutionMode?: AccountResolutionMode;
  @IsEnum(MappingAmountSource) amountSource!: MappingAmountSource;
  @IsOptional() @IsNumber() amountParam?: number;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsNumber() lineOrder?: number;
  @IsOptional() @IsString() notes?: string;
}

class MappingUpsertDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => MappingLineDto)
  lines!: MappingLineDto[];
}

class CostCenterDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CostCenterUpdateDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CloseYearDto {
  @IsNumber() year!: number;
}

@Controller('accounting')
export class AccountingController {
  constructor(
    private accounts: AccountsService,
    private journals: JournalService,
    private openings: OpeningService,
    private mappings: MappingService,
    private reports: AccountingReportsService,
    private queue: QueueService,
    private posting: PostingService,
    private cogsReconcile: CogsReconcileService,
    private depreciation: DepreciationService,
    private closing: ClosingService,
    private costCenters: CostCentersService,
    private reconciliation: ReconciliationService,
  ) {}

  // ── Accounts ──────────────────────────────────────────
  @Get('accounts/tree')
  accountsTree(@Query('activeOnly') activeOnly?: string) {
    return this.accounts.tree(activeOnly === '1' || activeOnly === 'true');
  }

  @Get('accounts')
  listAccounts(
    @Query('type') type?: AccountType,
    @Query('q') q?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.accounts.list({
      type,
      q,
      activeOnly: activeOnly === '1' || activeOnly === 'true',
    });
  }

  @Get('accounts/:id')
  getAccount(@Param('id') id: string) {
    return this.accounts.findOne(id);
  }

  @Post('accounts')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createAccount(@Body() dto: AccountDto, @Req() req: { user: { userId: string } }) {
    return this.accounts.create(dto, req.user.userId);
  }

  @Patch('accounts/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateAccount(
    @Param('id') id: string,
    @Body() dto: AccountUpdateDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.accounts.update(id, dto, req.user.userId);
  }

  @Delete('accounts/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  deleteAccount(@Param('id') id: string, @Req() req: { user: { userId: string } }) {
    return this.accounts.remove(id, req.user.userId);
  }

  // ── Journals ──────────────────────────────────────────
  @Get('journals')
  listJournals(
    @Query('status') status?: JournalEntryStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sourceType') sourceType?: AccountingEvent,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.journals.list({
      status,
      from,
      to,
      sourceType,
      q,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('journals/:id')
  getJournal(@Param('id') id: string) {
    return this.journals.findOne(id);
  }

  @Post('journals')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createJournal(@Body() dto: JournalDraftDto, @Req() req: { user: { userId: string } }) {
    return this.journals.createDraft({ ...dto, createdById: req.user.userId });
  }

  @Patch('journals/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateJournal(
    @Param('id') id: string,
    @Body() dto: Partial<JournalDraftDto>,
    @Req() req: { user: { userId: string } },
  ) {
    return this.journals.updateDraft(id, { ...dto, userId: req.user.userId });
  }

  @Post('journals/:id/post')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  postJournal(@Param('id') id: string, @Req() req: { user: { userId: string } }) {
    return this.journals.post(id, req.user.userId);
  }

  @Post('journals/:id/reverse')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  reverseJournal(
    @Param('id') id: string,
    @Body() dto: JournalReverseDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.journals.reverse(id, { ...dto, userId: req.user.userId });
  }

  @Delete('journals/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  deleteJournal(@Param('id') id: string, @Req() req: { user: { userId: string } }) {
    return this.journals.deleteDraft(id, req.user.userId);
  }

  // ── Openings ──────────────────────────────────────────
  @Get('openings')
  listOpenings(@Query('year') year?: string) {
    return this.openings.listBatches(year ? Number(year) : undefined);
  }

  @Get('openings/:id')
  getOpening(@Param('id') id: string) {
    return this.openings.findBatch(id);
  }

  @Post('openings')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createOpening(@Body() dto: OpeningBatchDto, @Req() req: { user: { userId: string } }) {
    return this.openings.createDraftBatch(dto.year, dto.notes, req.user.userId);
  }

  @Post('openings/:id/lines')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  addOpeningLine(
    @Param('id') id: string,
    @Body() dto: OpeningLineDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.openings.addLine(id, dto, req.user.userId);
  }

  @Patch('openings/lines/:lineId')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateOpeningLine(
    @Param('lineId') lineId: string,
    @Body() dto: Partial<OpeningLineDto>,
    @Req() req: { user: { userId: string } },
  ) {
    return this.openings.updateLine(lineId, dto, req.user.userId);
  }

  @Delete('openings/lines/:lineId')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  deleteOpeningLine(@Param('lineId') lineId: string, @Req() req: { user: { userId: string } }) {
    return this.openings.deleteLine(lineId, req.user.userId);
  }

  @Post('openings/:id/apply')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  applyOpening(@Param('id') id: string, @Req() req: { user: { userId: string } }) {
    return this.openings.applyBatch(id, req.user.userId);
  }

  @Post('openings/:id/reverse')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  reverseOpening(
    @Param('id') id: string,
    @Body() dto: JournalReverseDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.openings.reverseBatch(id, req.user.userId, dto.reason);
  }

  // ── Mappings ──────────────────────────────────────────
  @Get('mappings')
  listMappings() {
    return this.mappings.list();
  }

  @Get('mappings/:event')
  getMapping(@Param('event') event: AccountingEvent) {
    return this.mappings.getMapping(event);
  }

  @Put('mappings/:event')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  upsertMapping(
    @Param('event') event: AccountingEvent,
    @Body() dto: MappingUpsertDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.mappings.upsertLines(event, dto.lines, req.user.userId);
  }

  // ── Reports ───────────────────────────────────────────
  @Get('reports/trial-balance')
  trialBalance(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.trialBalance(from, to);
  }

  @Get('reports/gl')
  generalLedger(
    @Query('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.generalLedger(accountId, from, to);
  }

  @Get('reports/dashboard')
  dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.dashboardTotals(from, to);
  }

  // ── Queue / seed ──────────────────────────────────────
  @Get('queue')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  listQueue(@Query('status') status?: AccountingPostQueueStatus) {
    return this.queue.list(status);
  }

  @Post('queue/process')
  @Roles(Role.ADMIN)
  async processQueue(@Req() req: { user: { userId: string } }) {
    const item = await this.queue.claimNext(req.user.userId, 60_000);
    if (!item) return { processed: false, item: null };
    const entry = await this.posting.processQueueItem(item);
    return { processed: true, item, entry };
  }

  @Post('seed')
  @Roles(Role.ADMIN)
  seed(@Req() req: { user: { userId: string } }) {
    return this.mappings.seed(req.user.userId);
  }

  @Post('cogs/sweep')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  sweepCogs() {
    return this.cogsReconcile.sweepDirty(50);
  }

  @Get('reports/balance-sheet')
  balanceSheet(@Query('asOf') asOf?: string) {
    return this.reports.balanceSheet(asOf);
  }

  @Get('reports/income-statement')
  incomeStatement(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.incomeStatement(from, to);
  }

  @Get('reports/cash-flow')
  cashFlow(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.cashFlowStatement(from, to);
  }

  @Get('reports/tax')
  taxReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.taxReport(from, to);
  }

  @Get('reports/ar')
  arAging() {
    return this.reports.arAging();
  }

  @Get('reports/ap')
  apAging() {
    return this.reports.apAging();
  }

  @Get('reports/cost-centers')
  costCenterReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.costCenterReport(from, to);
  }

  @Get('reports/reconciliation')
  reconciliationAudit() {
    return this.reconciliation.runAudit();
  }

  // ── Cost centers ──────────────────────────────────────
  @Get('cost-centers')
  listCostCenters(@Query('activeOnly') activeOnly?: string) {
    return this.costCenters.list(activeOnly === '1' || activeOnly === 'true');
  }

  @Get('cost-centers/:id')
  getCostCenter(@Param('id') id: string) {
    return this.costCenters.findOne(id);
  }

  @Post('cost-centers')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createCostCenter(@Body() dto: CostCenterDto, @Req() req: { user: { userId: string } }) {
    return this.costCenters.create(dto, req.user.userId);
  }

  @Patch('cost-centers/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateCostCenter(
    @Param('id') id: string,
    @Body() dto: CostCenterUpdateDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.costCenters.update(id, dto, req.user.userId);
  }

  // ── Fiscal year closing ───────────────────────────────
  @Post('closing/preview')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  previewClose(@Query('year') year?: string, @Body() body?: { year?: number }) {
    const y = Number(body?.year ?? year);
    return this.closing.previewClose(y);
  }

  @Post('closing/close')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  closeYear(@Body() dto: CloseYearDto, @Req() req: { user: { userId: string } }) {
    return this.closing.closeYear(Number(dto.year), req.user.userId);
  }

  @Post('depreciation/run')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  runDepreciation(
    @Body() body: { year: number; month: number },
    @Req() req: { user: { userId: string } },
  ) {
    return this.depreciation.runMonth(Number(body.year), Number(body.month), req.user.userId);
  }
}
