import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BotService } from './bot.service';

type ReminderKind =
  | '3d'
  | '1d'
  | 'expired';

@Injectable()
export class SubscriptionNotificationsService {
  private readonly logger =
    new Logger(
      SubscriptionNotificationsService.name,
    );

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly botService: BotService,
  ) {}

  @Cron('*/5 * * * *')
  async processSubscriptionNotifications() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const now = new Date();

      const oneDay =
        24 * 60 * 60 * 1000;

      const active = await this.prisma.subscription.findMany({
        where: {
          status: {
            in: [
              SubscriptionStatus.ACTIVE,
              SubscriptionStatus.TRIAL,
            ],
          },
          expiresAt: {
            gt: now,
            lte: new Date(
              now.getTime() +
                3 * oneDay,
            ),
          },
          user: {
            isBlocked: false,
          },
        },
        select: {
          id: true,
          expiresAt: true,
          user: {
            select: {
              id: true,
              telegramId: true,
            },
          },
        },
      });

      for (const sub of active) {
        const remainingMs =
          sub.expiresAt.getTime() -
          now.getTime();

        const kind: ReminderKind =
          remainingMs <= oneDay
            ? '1d'
            : '3d';

        await this.deliver(
          sub.id,
          sub.expiresAt,
          sub.user.id,
          sub.user.telegramId,
          kind,
        );
      }

      /*
       * Только недавно истёкшие подписки:
       * не отправляем уведомления по старой
       * истории при первом запуске функции.
       *
       * Окно 24 часа позволяет пережить
       * рестарт/простой приложения.
       */
      const expired =
        await this.prisma.subscription.findMany({
          where: {
            status:
              SubscriptionStatus.EXPIRED,
            expiresAt: {
              lte: now,
              gte: new Date(
                now.getTime() - oneDay,
              ),
            },
            user: {
              isBlocked: false,
            },
          },
          select: {
            id: true,
            expiresAt: true,
            user: {
              select: {
                id: true,
                telegramId: true,
              },
            },
          },
        });

      for (const sub of expired) {
        await this.deliver(
          sub.id,
          sub.expiresAt,
          sub.user.id,
          sub.user.telegramId,
          'expired',
        );
      }
    } catch (error) {
      this.logger.error(
        'Subscription notification cron failed',
        error instanceof Error
          ? error.stack
          : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  private getContent(kind: ReminderKind) {
    if (kind === '3d') {
      return {
        title:
          'Подписка скоро закончится',
        body:
          'До окончания подписки осталось около 3 дней. Продлите её заранее, чтобы VPN продолжил работать без перерыва.',
        telegram:
          '⏳ <b>Подписка скоро закончится</b>\n\nДо окончания подписки осталось около <b>3 дней</b>.\n\nПродлите её заранее, чтобы VPN продолжил работать без перерыва.',
      };
    }

    if (kind === '1d') {
      return {
        title:
          'До окончания подписки остался 1 день',
        body:
          'До окончания подписки осталось менее суток. Продлите подписку, чтобы сохранить непрерывный доступ к VPN.',
        telegram:
          '⚠️ <b>До окончания подписки остался 1 день</b>\n\nПродлите подписку, чтобы сохранить непрерывный доступ к VPN.',
      };
    }

    return {
      title:
        'Подписка закончилась',
      body:
        'Срок подписки истёк. VPN-доступ приостановлен. Продлите подписку, чтобы восстановить доступ.',
      telegram:
        '🔒 <b>Подписка закончилась</b>\n\nСрок подписки истёк, поэтому VPN-доступ приостановлен.\n\nПродлите подписку, чтобы восстановить доступ.',
    };
  }

  private makeDedupeKey(
    subscriptionId: string,
    expiresAt: Date,
    kind: ReminderKind,
  ) {
    return [
      'subscription',
      subscriptionId,
      expiresAt.toISOString(),
      kind,
    ].join(':');
  }

  private async deliver(
    subscriptionId: string,
    expiresAt: Date,
    userId: string,
    telegramId: bigint,
    kind: ReminderKind,
  ) {
    const dedupeKey =
      this.makeDedupeKey(
        subscriptionId,
        expiresAt,
        kind,
      );

    const content =
      this.getContent(kind);

    let notification =
      await this.prisma.notification.findUnique({
        where: {
          dedupeKey,
        },
        select: {
          id: true,
          telegramSentAt: true,
        },
      });

    if (!notification) {
      try {
        notification =
          await this.prisma.notification.create({
            data: {
              title: content.title,
              body: content.body,
              isActive: true,
              recipientUserId: userId,
              dedupeKey,
            },
            select: {
              id: true,
              telegramSentAt: true,
            },
          });
      } catch (error) {
        if (
          error instanceof
            Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          notification =
            await this.prisma.notification.findUnique({
              where: {
                dedupeKey,
              },
              select: {
                id: true,
                telegramSentAt: true,
              },
            });
        } else {
          throw error;
        }
      }
    }

    if (
      !notification ||
      notification.telegramSentAt
    ) {
      return;
    }

    try {
      await this.botService.bot.api.sendMessage(
        Number(telegramId),
        content.telegram,
        {
          parse_mode: 'HTML',
        },
      );

      await this.prisma.notification.update({
        where: {
          id: notification.id,
        },
        data: {
          telegramSentAt:
            new Date(),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Telegram subscription notification failed: ${kind}`,
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }
}
