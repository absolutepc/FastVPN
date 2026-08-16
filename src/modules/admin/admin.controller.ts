import { Controller, Get, Param } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
  ) {}

  @Get('users')
  getUsers() {
    return this.admin.getUsers();
  }

  @Get('users/:id')
  getUser(
    @Param('id') id: string,
  ) {
    return this.admin.getUser(id);
  }
}
