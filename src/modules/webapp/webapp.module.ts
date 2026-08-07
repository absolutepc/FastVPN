import { Module } from '@nestjs/common';
import { WebappController } from './webapp.controller';
import { WebappService } from './webapp.service';
import { PaymentsModule } from '../payments/payments.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [PaymentsModule, SubscriptionsModule],
  controllers: [WebappController],
  providers: [WebappService],
  exports: [WebappService],
})
export class WebappModule {}
