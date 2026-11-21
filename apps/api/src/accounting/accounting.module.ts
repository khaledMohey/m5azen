import { Module } from '@nestjs/common';
import { SequenceService } from '../common/sequence.service';
import { AccountingController } from './accounting.controller';
import { AccountsService } from './accounts.service';
import { JournalService } from './journal.service';
import { OpeningService } from './opening.service';
import { MappingService } from './mapping.service';
import { PostingService } from './posting.service';
import { AccountingReportsService } from './reports.service';
import { QueueService } from './queue.service';
import { CogsLockService } from './cogs-lock.service';
import { AuditService } from './audit.service';
import { CogsReconcileService } from './cogs-reconcile.service';
import { DepreciationService } from './depreciation.service';
import { ClosingService } from './closing.service';
import { CostCentersService } from './cost-centers.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  controllers: [AccountingController],
  providers: [
    SequenceService,
    AuditService,
    AccountsService,
    JournalService,
    OpeningService,
    MappingService,
    PostingService,
    AccountingReportsService,
    QueueService,
    CogsLockService,
    CogsReconcileService,
    DepreciationService,
    ClosingService,
    CostCentersService,
    ReconciliationService,
  ],
  exports: [
    PostingService,
    CogsLockService,
    QueueService,
    JournalService,
    MappingService,
    CogsReconcileService,
    DepreciationService,
    ReconciliationService,
    ClosingService,
    CostCentersService,
  ],
})
export class AccountingModule {}
