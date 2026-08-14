import { DeviceLimitService } from './device-limit.service';
import { Module, forwardRef } from '@nestjs/common';
import { BotService } from './bot.service';
import { NodeMonitorService } from './node-monitor.service';
import { BotUpdate } from './bot.update';
import { AdminUpdate } from './admin.update';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { XrayModule } from '../modules/xray/xray.module';

@Module({
  imports: [SubscriptionsModule, forwardRef(() => PaymentsModule), XrayModule],
  providers: [BotService, BotUpdate, AdminUpdate, NodeMonitorService, DeviceLimitService],
  exports: [BotService],
})
export class BotModule {}
