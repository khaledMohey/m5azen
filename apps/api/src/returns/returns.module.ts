import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { SequenceService } from '../common/sequence.service';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [AccountingModule],
  controllers: [ReturnsController],
  providers: [ReturnsService, SequenceService],
})
export class ReturnsModule {}
