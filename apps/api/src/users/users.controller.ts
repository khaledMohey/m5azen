import { Body, Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { Roles } from '../common/guards';

class CreateUserDto {
  @IsString() username!: string;
  @IsString() @MinLength(4) password!: string;
  @IsString() fullName!: string;
  @IsEnum(Role) role!: Role;
}

class UpdateUserDto {
  @IsOptional() @IsString() fullName?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MinLength(4) password?: string;
}

@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Get('me/warehouses')
  myWarehouses(@Req() req: { user: { userId: string; role: Role } }) {
    if (req.user.role === Role.ADMIN) return [];
    return this.users.warehouses(req.user.userId);
  }

  @Get(':id/warehouses')
  warehouses(@Param('id') id: string) {
    return this.users.warehouses(id);
  }

  @Put(':id/warehouses')
  setWarehouses(@Param('id') id: string, @Body() body: { warehouseIds: string[] }) {
    return this.users.setWarehouses(id, body.warehouseIds || []);
  }
}
