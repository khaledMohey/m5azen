import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { AttendanceService } from './attendance.service';
import { CommissionsService } from './commissions.service';
import { EmployeesService } from './employees.service';
import { HrController } from './hr.controller';
import { HrSettingsService } from './hr-settings.service';
import { LeavesMovementsService } from './leaves-movements.service';
import { PayrollService } from './payroll.service';
import { RequestsService } from './requests.service';
import { ensureEgyptTz } from './egypt-time';

ensureEgyptTz();

@Module({
  imports: [FinanceModule],
  controllers: [HrController],
  providers: [
    HrSettingsService,
    EmployeesService,
    AttendanceService,
    LeavesMovementsService,
    RequestsService,
    PayrollService,
    CommissionsService,
  ],
  exports: [EmployeesService],
})
export class HrModule {}
