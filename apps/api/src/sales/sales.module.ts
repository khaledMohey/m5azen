import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SequenceService } from '../common/sequence.service';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [AccountingModule],
  controllers: [SalesController],
  providers: [SalesService, SequenceService],
  exports: [SalesService],
})
export class SalesModule {}
