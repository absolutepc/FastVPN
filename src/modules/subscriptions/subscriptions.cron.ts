import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { XrayService } from '../xray/xray.service';
import { SubscriptionsService } from './subscriptions.service';

@Injectable()
export class SubscriptionsCron {
  private readonly logger = new Logger(SubscriptionsCron.name);
  private recoveryRunning = false;
  private h1RecoveryRunning = false;

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly prisma: PrismaService,
    private readonly xray: XrayService,
  ) {}

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

  /** Автоматически восстанавливаем пользователей после рестарта Xray */
  @Cron('*/2 * * * *')
  async recoverNodeUsers() {
    if (this.recoveryRunning) return;

    this.recoveryRunning = true;

    try {
      const nodes = await this.prisma.node.findMany({
        where: {
          isActive: true,
        },
      });

      for (const node of nodes) {
        const expected = await this.xray.countUsersOnNodeType(node.type);

        const actual = await this.xray.getUsersCountOnNode(node);

        if (actual === null) {
          this.logger.warn(
            `Recovery check skipped for ${node.name}: Xray API unavailable`,
          );
          continue;
        }

        if (actual >= expected) {
          continue;
        }

        this.logger.warn(
          `Recovering ${node.name}: actual=${actual} expected=${expected}`,
        );

        const sync = await this.xray.syncActiveUsersToNode(node);

        this.logger.log(
          `Recovery ${node.name}: total=${sync.total} ok=${sync.ok} fail=${sync.fail}`,
        );
      }
    } catch (e) {
      this.logger.error(
        'Node user recovery failed',
        e instanceof Error ? e.message : e,
      );
    } finally {
      this.recoveryRunning = false;
    }
  }
  /** Восстанавливаем отсутствующих клиентов H1Cloud */
  @Cron('*/2 * * * *')
  async recoverH1CloudClients() {
    if (this.h1RecoveryRunning) return;

    this.h1RecoveryRunning = true;

    try {
      const result = await this.subscriptions.recoverMissingH1CloudClients();

      if (result.total > 0) {
        this.logger.log(
          `H1Cloud recovery: total=${result.total} ok=${result.ok} fail=${result.fail}`,
        );
      }
    } catch (error) {
      this.logger.error(
        'H1Cloud recovery failed',
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.h1RecoveryRunning = false;
    }
  }
}
