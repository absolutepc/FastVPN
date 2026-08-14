import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsCron } from './subscriptions.cron';
import { XrayModule } from '../xray/xray.module';
import { H1CloudModule } from '../h1cloud/h1cloud.module';

@Module({
  imports: [XrayModule, H1CloudModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsCron],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
