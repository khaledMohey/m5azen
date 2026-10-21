import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';

function warehouseIds(many?: string, one?: string) {
  const raw = (many || one || '').split(',').map((id) => id.trim()).filter(Boolean);
  return raw.length ? raw : undefined;
}

@Controller('reports')
export class ReportsController {
  constructor(private service: ReportsService) {}

  @Get('inventory')
  inventory(@Query('warehouseIds') warehouseIdsQuery?: string, @Query('warehouseId') warehouseId?: string) {
    return this.service.inventory(warehouseIds(warehouseIdsQuery, warehouseId));
  }

  @Get('sales')
  sales(@Query('from') from?: string, @Query('to') to?: string, @Query('warehouseIds') warehouseIdsQuery?: string) {
    return this.service.salesSummary(from, to, warehouseIds(warehouseIdsQuery));
  }

  @Get('purchases')
  purchases(@Query('from') from?: string, @Query('to') to?: string, @Query('warehouseIds') warehouseIdsQuery?: string) {
    return this.service.purchasesSummary(from, to, warehouseIds(warehouseIdsQuery));
  }

  @Get('profit')
  profit(@Query('from') from?: string, @Query('to') to?: string, @Query('warehouseIds') warehouseIdsQuery?: string) {
    return this.service.profit(from, to, warehouseIds(warehouseIdsQuery));
  }

  @Get('cash')
  cash(@Query('from') from?: string, @Query('to') to?: string, @Query('warehouseIds') warehouseIdsQuery?: string) {
    return this.service.cashReport(from, to, warehouseIds(warehouseIdsQuery));
  }

  @Get('products')
  products(@Query('from') from?: string, @Query('to') to?: string, @Query('warehouseIds') warehouseIdsQuery?: string) {
    return this.service.productInsights(from, to, warehouseIds(warehouseIdsQuery));
  }

  @Get('inventory/excel')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async inventoryExcel(
    @Query('warehouseIds') warehouseIdsQuery: string | undefined,
    @Query('warehouseId') warehouseId: string | undefined,
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportInventoryExcel(warehouseIds(warehouseIdsQuery, warehouseId));
    res.setHeader('Content-Disposition', 'attachment; filename=inventory.xlsx');
    res.send(buffer);
  }
}
