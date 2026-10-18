import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsObject, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { SettingsService } from './settings.service';
import { Roles } from '../common/guards';
import { SettingsGateGuard, settingsPasswordMatches, signSettingsToken } from './settings-gate';

class UpdateSettingsDto {
  @IsObject()
  data!: Record<string, string>;
}

class UnlockSettingsDto {
  @IsString() @MinLength(1) password!: string;
}

@Controller('settings')
export class SettingsController {
  constructor(private service: SettingsService) {}

  @Post('unlock')
  unlock(@Body() dto: UnlockSettingsDto) {
    if (!process.env.SETTINGS_PASSWORD) throw new BadRequestException('تعذر فتح الإعدادات');
    if (!settingsPasswordMatches(dto.password)) throw new BadRequestException('كلمة سر الإعدادات غير صحيحة');
    return { token: signSettingsToken() };
  }

  @Get()
  @UseGuards(SettingsGateGuard)
  getAll() {
    return this.service.getAll();
  }

  @Post()
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  update(@Body() dto: UpdateSettingsDto) {
    return this.service.updateMany(dto.data);
  }

  @Post('backup')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  backup() {
    return this.service.backup();
  }

  @Get('backups')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  listBackups() {
    return this.service.listBackups();
  }
}
