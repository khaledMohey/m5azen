import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private service: ReportsService) {}

  @Get('inventory')
  inventory(@Query('warehouseId') warehouseId?: string) {
    return this.service.inventory(warehouseId);
  }

  @Get('sales')
  sales(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.salesSummary(from, to);
  }

  @Get('purchases')
  purchases(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.purchasesSummary(from, to);
  }

  @Get('profit')
  profit(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.profit(from, to);
  }

  @Get('cash')
  cash(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.cashReport(from, to);
  }

  @Get('products')
  products(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.productInsights(from, to);
  }

  @Get('inventory/excel')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async inventoryExcel(
    @Query('warehouseId') warehouseId: string | undefined,
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportInventoryExcel(warehouseId);
    res.setHeader('Content-Disposition', 'attachment; filename=inventory.xlsx');
    res.send(buffer);
  }
}
