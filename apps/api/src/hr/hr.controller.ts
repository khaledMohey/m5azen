import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import {
  HrLeaveType, HrMovementKind, HrRequestKind, Role,
} from '@prisma/client';
import { Roles } from '../common/guards';
import { AttendanceService } from './attendance.service';
import { CommissionsService } from './commissions.service';
import { EmployeesService } from './employees.service';
import { HrSettingsService } from './hr-settings.service';
import { LeavesMovementsService } from './leaves-movements.service';
import { PayrollService } from './payroll.service';
import { RequestsService } from './requests.service';

type ReqUser = { user: { userId: string; role: string } };

@Controller('hr')
export class HrController {
  constructor(
    private settings: HrSettingsService,
    private employees: EmployeesService,
    private attendance: AttendanceService,
    private leavesMovements: LeavesMovementsService,
    private requests: RequestsService,
    private payroll: PayrollService,
    private commissionsService: CommissionsService,
  ) {}

  @Get('settings')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  getSettings() {
    return this.settings.get();
  }

  @Patch('settings')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateSettings(@Body() body: Record<string, unknown>) {
    return this.settings.update(body as never);
  }

  @Get('holidays')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  holidays() {
    return this.settings.listHolidays();
  }

  @Post('holidays')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createHoliday(@Body() body: { date: string; name: string; yearly?: boolean }) {
    return this.settings.createHoliday(body);
  }

  @Delete('holidays/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  removeHoliday(@Param('id') id: string) {
    return this.settings.removeHoliday(id);
  }

  @Get('me')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  me(@Req() req: ReqUser) {
    return this.employees.me(req.user.userId);
  }

  @Get('linkable-users')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  linkable(@Query('employeeId') employeeId?: string) {
    return this.employees.linkableUsers(employeeId);
  }

  @Get('employees/next-code')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  nextCode() {
    return this.employees.nextCode().then((code) => ({ code }));
  }

  @Get('employees')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  employeesList(@Query('active') active?: string) {
    return this.employees.list(active === '1');
  }

  @Get('employees/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  employeeOne(@Param('id') id: string) {
    return this.employees.findOne(id);
  }

  @Post('employees')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createEmployee(@Body() body: Record<string, unknown>) {
    return this.employees.create(body as never);
  }

  @Patch('employees/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateEmployee(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.employees.update(id, body as never);
  }

  @Post('employees/:id/account')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createAccount(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.employees.createAccount(id, body as never);
  }

  @Patch('employees/:id/account')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  updateAccount(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.employees.updateAccount(id, body as never);
  }

  @Get('attendance')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  attendanceList(@Query('from') from?: string, @Query('to') to?: string, @Query('employeeId') employeeId?: string) {
    return this.attendance.list({ from, to, employeeId });
  }

  @Post('attendance')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  upsertAttendance(@Body() body: Record<string, unknown>) {
    return this.attendance.upsert(body as never);
  }

  @Post('attendance/punch-in')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  async punchIn(@Req() req: ReqUser, @Body() body: { employeeId?: string }) {
    const employeeId = await this.resolveSelfEmployee(req, body.employeeId);
    return this.attendance.punchIn(employeeId);
  }

  @Post('attendance/punch-out')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  async punchOut(@Req() req: ReqUser, @Body() body: { employeeId?: string }) {
    const employeeId = await this.resolveSelfEmployee(req, body.employeeId);
    return this.attendance.punchOut(employeeId);
  }

  @Post('attendance/recalculate-late')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  recalculateLate() {
    return this.attendance.recalculateLate();
  }

  @Get('attendance/missions')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  missions(@Query('from') from?: string, @Query('to') to?: string, @Query('employeeId') employeeId?: string) {
    return this.attendance.listMissions({ from, to, employeeId });
  }

  @Post('attendance/mission-out')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  async missionOut(@Req() req: ReqUser, @Body() body: { employeeId?: string; purpose: string; notes?: string }) {
    const employeeId = await this.resolveSelfEmployee(req, body.employeeId);
    return this.attendance.missionOut({ employeeId, purpose: body.purpose, notes: body.notes });
  }

  @Post('attendance/mission-in')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  async missionIn(@Req() req: ReqUser, @Body() body: { employeeId?: string }) {
    const employeeId = await this.resolveSelfEmployee(req, body.employeeId);
    return this.attendance.missionIn(employeeId);
  }

  @Delete('attendance/missions/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  removeMission(@Param('id') id: string) {
    return this.attendance.removeMission(id);
  }

  @Delete('attendance/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  removeAttendance(@Param('id') id: string) {
    return this.attendance.remove(id);
  }

  @Get('leaves')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  leaves(@Query('from') from?: string, @Query('to') to?: string, @Query('employeeId') employeeId?: string) {
    return this.leavesMovements.listLeaves({ from, to, employeeId });
  }

  @Post('leaves')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createLeave(@Body() body: { employeeId: string; type: HrLeaveType; fromDate: string; toDate: string; hours?: number; notes?: string }) {
    return this.leavesMovements.createLeave(body);
  }

  @Delete('leaves/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  removeLeave(@Param('id') id: string) {
    return this.leavesMovements.removeLeave(id);
  }

  @Get('movements')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  movements(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('employeeId') employeeId?: string,
    @Query('kind') kind?: HrMovementKind,
  ) {
    return this.leavesMovements.listMovements({ from, to, employeeId, kind });
  }

  @Post('movements')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createMovement(@Body() body: { employeeId: string; kind: HrMovementKind; amount: number; movementDate: string; notes?: string }) {
    return this.leavesMovements.createMovement(body);
  }

  @Delete('movements/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  removeMovement(@Param('id') id: string) {
    return this.leavesMovements.removeMovement(id);
  }

  @Get('requests')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  listRequests(
    @Req() req: ReqUser,
    @Query('status') status?: string,
    @Query('employeeId') employeeId?: string,
    @Query('mine') mine?: string,
  ) {
    return this.requests.list(req.user, { status, employeeId, mine });
  }

  @Post('requests')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  createRequest(@Req() req: ReqUser, @Body() body: {
    employeeId?: string;
    kind: HrRequestKind;
    leaveType?: HrLeaveType;
    fromDate?: string;
    toDate?: string;
    hours?: number;
    amount?: number;
    reason?: string;
    notes?: string;
  }) {
    return this.requests.create(req.user, body);
  }

  @Post('requests/:id/cancel')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES, Role.WAREHOUSE)
  cancelRequest(@Req() req: ReqUser, @Param('id') id: string) {
    return this.requests.cancel(req.user, id);
  }

  @Post('requests/:id/approve')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  approveRequest(@Req() req: ReqUser, @Param('id') id: string, @Body() body?: { deductHours?: number; notes?: string }) {
    return this.requests.approve(req.user, id, body);
  }

  @Post('requests/:id/reject')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  rejectRequest(@Req() req: ReqUser, @Param('id') id: string, @Body() body?: { reason?: string }) {
    return this.requests.reject(req.user, id, body);
  }

  @Get('payroll/covered')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  covered(@Query('employeeId') employeeId?: string) {
    return this.payroll.covered(employeeId);
  }

  @Get('payroll/payments')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  payrollPayments() {
    return this.payroll.listPayments();
  }

  @Post('payroll/calc')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  calc(@Body() body: { from: string; to: string; employeeIds?: string[] }) {
    return this.payroll.calc(body.from, body.to, body.employeeIds);
  }

  @Post('payroll/runs')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  createRun(@Body() body: { from: string; to: string; employeeIds?: string[]; notes?: string; methodId?: string }) {
    return this.payroll.createRun(body);
  }

  @Get('payroll/runs')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  listRuns() {
    return this.payroll.listRuns();
  }

  @Get('payroll/runs/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  getRun(@Param('id') id: string) {
    return this.payroll.findRun(id);
  }

  @Post('payroll/runs/:id/post')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  postRun(@Req() req: ReqUser, @Param('id') id: string, @Body() body?: { methodId?: string }) {
    return this.payroll.post(id, req.user.userId, body?.methodId);
  }

  @Post('payroll/runs/:id/pay')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  payRun(@Req() req: ReqUser, @Param('id') id: string, @Body() body?: { methodId?: string }) {
    return this.payroll.pay(id, req.user.userId, body?.methodId);
  }

  @Post('payroll/runs/:id/reverse-payment')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  reversePayment(@Req() req: ReqUser, @Param('id') id: string, @Body() body?: { reason?: string }) {
    return this.payroll.reversePayment(id, req.user.userId, body?.reason);
  }

  @Post('payroll/runs/:id/reverse')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  reverseRun(@Req() req: ReqUser, @Param('id') id: string, @Body() body?: { reason?: string }) {
    return this.payroll.reverseAccrual(id, req.user.userId, body?.reason);
  }

  @Get('payroll/payables')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  employeePayables() {
    return this.payroll.employeePayables();
  }

  @Delete('payroll/runs/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  removeRun(@Param('id') id: string) {
    return this.payroll.remove(id);
  }

  @Get('commissions')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  commissionsSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.commissionsService.summary(from, to);
  }

  @Get('commissions/payments')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  commissionPayments(@Query('from') from?: string, @Query('to') to?: string) {
    return this.commissionsService.listPayments(from, to);
  }

  @Post('commissions/pay')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  payCommission() {
    return this.commissionsService.pay();
  }

  private async resolveSelfEmployee(req: ReqUser, employeeId?: string) {
    if ((req.user.role === Role.ADMIN || req.user.role === Role.ACCOUNTANT) && employeeId) {
      return employeeId;
    }
    const me = await this.employees.me(req.user.userId);
    if (!me) throw new BadRequestException('حسابك مش مربوط بملف موظف');
    return me.id;
  }
}
