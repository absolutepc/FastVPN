import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { AdminUpdate } from './admin.update';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule],
  providers: [BotService, BotUpdate, AdminUpdate],
  exports: [BotService],
})
export class BotModule {}
