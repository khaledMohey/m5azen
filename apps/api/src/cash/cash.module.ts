import { Module } from '@nestjs/common';
import { CashController } from './cash.controller';
import { CashService } from './cash.service';
import { SequenceService } from '../common/sequence.service';

@Module({
  controllers: [CashController],
  providers: [CashService, SequenceService],
  exports: [CashService],
})
export class CashModule {}
