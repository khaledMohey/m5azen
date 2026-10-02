import { Module } from '@nestjs/common';
import { SequenceService } from '../common/sequence.service';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  controllers: [LedgerController],
  providers: [LedgerService, SequenceService],
})
export class LedgerModule {}