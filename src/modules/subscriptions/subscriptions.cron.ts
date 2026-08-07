import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SubscriptionsService } from './subscriptions.service';

@Injectable()
export class SubscriptionsCron {
  private readonly logger = new Logger(SubscriptionsCron.name);

  constructor(private readonly subscriptions: SubscriptionsService) {}

  /** Каждые 2 минуты помечаем истёкшие подписки */
  @Cron('*/2 * * * *')
  async handleExpired() {
    try {
      const count = await this.subscriptions.expireOverdueSubscriptions();
      if (count > 0) {
        this.logger.log(`Cron: expired ${count} subscription(s)`);
      }
    } catch (e) {
      this.logger.error('Cron expire failed', e);
    }
  }
}
