import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsObject } from 'class-validator';
import { Role } from '@prisma/client';
import { SettingsService } from './settings.service';
import { Roles } from '../common/guards';

class UpdateSettingsDto {
  @IsObject()
  data!: Record<string, string>;
}

@Controller('settings')
export class SettingsController {
  constructor(private service: SettingsService) {}

  @Get()
  getAll() {
    return this.service.getAll();
  }

  @Post()
  @Roles(Role.ADMIN)
  update(@Body() dto: UpdateSettingsDto) {
    return this.service.updateMany(dto.data);
  }

  @Post('backup')
  @Roles(Role.ADMIN)
  backup() {
    return this.service.backup();
  }

  @Get('backups')
  @Roles(Role.ADMIN)
  listBackups() {
    return this.service.listBackups();
  }
}
