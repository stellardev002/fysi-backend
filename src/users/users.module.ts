import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminUsersController } from './admin-users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController],
  providers: [UsersService],
})
export class UsersModule {}
