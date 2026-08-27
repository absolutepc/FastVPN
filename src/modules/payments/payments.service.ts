import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  PlanType,
  PaymentStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { Cron } from '@nestjs/schedule';

const PLAN_PRICES: Record<PlanType, number> = {
  STANDARD: 30000,
  PREMIUM: 60000,
};

const SUBSCRIPTION_PERIODS = {
  1: 0,
  3: 10,
  6: 20,
  9: 35,
  12: 50,
} as const;

type SubscriptionMonths =
  keyof typeof SUBSCRIPTION_PERIODS;

const DAYS_PER_MONTH = 30;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private async withSerializableRetry<T>(
    operation: () => Promise<T>,
    attempts = 3,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= attempts;
      attempt++
    ) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof
            Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';

        if (!retryable || attempt === attempts) {
          throw error;
        }

        this.logger.warn(
          `Serializable payment transaction conflict; retry ${attempt}/${attempts}`,
        );
      }
    }

    throw new Error(
      'SERIALIZABLE_PAYMENT_RETRY_EXHAUSTED',
    );
  }

  private normalizeDurationMonths(
    months: number,
  ): SubscriptionMonths {
    if (
      !Number.isInteger(months) ||
      !(months in SUBSCRIPTION_PERIODS)
    ) {
      throw new Error(
        'INVALID_SUBSCRIPTION_DURATION',
      );
    }

    return months as SubscriptionMonths;
  }

  @Cron('0 * * * *')
  async cleanupExpiredPendingPayments(): Promise<void> {
    const cutoff = new Date(
      Date.now() - 72 * 60 * 60 * 1000,
    );

    try {
      const result =
        await this.prisma.payment.updateMany({
          where: {
            status: PaymentStatus.PENDING,
            createdAt: {
              lt: cutoff,
            },
            proofFileId: null,
            reviewedAt: null,
            appliedAt: null,
          },
          data: {
            status: PaymentStatus.CANCELLED,
          },
        });

      if (result.count > 0) {
        this.logger.log(
          `Auto-cancelled ${result.count} expired pending payment(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Failed to auto-cancel expired pending payments',
        error instanceof Error
          ? error.stack
          : String(error),
      );
    }
  }

  getDiscountPercent(months: number): number {
    const duration =
      this.normalizeDurationMonths(months);

    return SUBSCRIPTION_PERIODS[duration];
  }

  getDurationDays(months: number): number {
    const duration =
      this.normalizeDurationMonths(months);

    return duration * DAYS_PER_MONTH;
  }

  getPrice(
    plan: PlanType,
    months = 1,
  ): number {
    const duration =
      this.normalizeDurationMonths(months);

    const base =
      PLAN_PRICES[plan] * duration;

    const discount =
      SUBSCRIPTION_PERIODS[duration];

    return Math.round(
      base * (100 - discount) / 100,
    );
  }

 async createManualPayment(params: {
  userId: string;
  plan: PlanType;
  bank: 'TBANK' | 'SBER';
  durationMonths?: number;
}) {
  const durationMonths =
    this.normalizeDurationMonths(
      params.durationMonths ?? 1,
    );

  const baseAmount =
    PLAN_PRICES[params.plan] *
    durationMonths;

  const amount =
    this.getPrice(
      params.plan,
      durationMonths,
    );

  const durationDays =
    this.getDurationDays(
      durationMonths,
    );

  return this.prisma.payment.create({
    data: {
      userId: params.userId,
      amount,
      baseAmount,
      durationMonths,
      feeAmount: 0,
      feePercent: 0,
      currency: 'RUB',
      plan: params.plan,
      status: PaymentStatus.PENDING,
      paymentMethod: 'MANUAL_SBP',
      paymentProvider: 'MANUAL',
      bank: params.bank,
      description:
        `4StepsVPN — ${durationMonths} мес. (${durationDays} дн.) — ручная оплата`,
    },
  });
}

async rejectManualPayment(
  paymentId: string,
  adminTelegramId: string,
) {
  const payment = await this.prisma.payment.findUnique({
    where: { id: paymentId },
  });

  if (!payment) {
    throw new Error('PAYMENT_NOT_FOUND');
  }

  if (
    payment.paymentProvider !== 'MANUAL' ||
    payment.paymentMethod !== 'MANUAL_SBP'
  ) {
    throw new Error('PAYMENT_NOT_MANUAL');
  }

  const rejected =
    await this.prisma.payment.updateMany({
      where: {
        id: paymentId,
        status: PaymentStatus.PENDING,
        appliedAt: null,
        paymentProvider: 'MANUAL',
        paymentMethod: 'MANUAL_SBP',
      },
      data: {
        status: PaymentStatus.CANCELLED,
        reviewedAt: new Date(),
        reviewedBy: adminTelegramId,
      },
    });

  if (rejected.count === 1) {
    const updated =
      await this.prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

    this.logger.log(
      `Manual payment ${paymentId} rejected`,
    );

    return {
      payment: updated,
      rejected: true,
    };
  }

  const current =
    await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

  return {
    payment: current,
    rejected: false,
  };
}

async approveManualPayment(
  paymentId: string,
  adminTelegramId: string,
) {
  const result =
    await this.withSerializableRetry(() =>
      this.prisma.$transaction(
    async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment) {
        throw new Error('PAYMENT_NOT_FOUND');
      }

      if (
        payment.paymentProvider !== 'MANUAL' ||
        payment.paymentMethod !== 'MANUAL_SBP'
      ) {
        throw new Error('PAYMENT_NOT_MANUAL');
      }

      if (
        payment.appliedAt ||
        payment.status === PaymentStatus.SUCCEEDED
      ) {
        return {
          payment,
          applied: false,
          subscriptionId:
            payment.appliedSubscriptionId,
          mode: null as
            | 'CREATED'
            | 'RESTORED'
            | 'EXTENDED'
            | null,
        };
      }

      if (payment.status !== PaymentStatus.PENDING) {
        throw new Error('PAYMENT_NOT_PENDING');
      }

      const now = new Date();

      /*
       * Атомарно "захватываем" платёж.
       * Второй approve будет ждать эту транзакцию,
       * а после commit уже не сможет получить count=1.
       *
       * Если транзакция упадёт дальше — этот UPDATE
       * тоже откатится.
       */
      const claimed = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentStatus.PENDING,
          appliedAt: null,
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          appliedAt: now,
          reviewedAt: now,
          reviewedBy: adminTelegramId,
        },
      });

      if (claimed.count !== 1) {
        const current = await tx.payment.findUnique({
          where: { id: payment.id },
        });

        if (
          current?.appliedAt ||
          current?.status === PaymentStatus.SUCCEEDED
        ) {
          return {
            payment: current,
            applied: false,
            subscriptionId:
              current.appliedSubscriptionId,
            mode: null as
              | 'CREATED'
              | 'RESTORED'
              | 'EXTENDED'
              | null,
          };
        }

        throw new Error('PAYMENT_ALREADY_PROCESSING');
      }

      const durationDays =
        this.getDurationDays(
          payment.durationMonths,
        );

      const expiresAt = new Date(now);
      expiresAt.setDate(
        expiresAt.getDate() + durationDays,
      );

      let subscription;
      let mode:
        | 'CREATED'
        | 'RESTORED'
        | 'EXTENDED';

      const occupying =
        await tx.subscription.findFirst({
          where: {
            userId: payment.userId,
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.TRIAL,
              ],
            },
          },
          orderBy: {
            expiresAt: 'desc',
          },
        });

      if (
        occupying &&
        occupying.expiresAt <= now
      ) {
        throw new Error(
          'ACTIVE_SUBSCRIPTION_EXPIRY_PENDING',
        );
      }

      if (
        occupying &&
        occupying.plan !== payment.plan
      ) {
        throw new Error(
          'ACTIVE_SUBSCRIPTION_PLAN_CONFLICT',
        );
      }

      const active =
        occupying ?? null;

      if (active) {
        const newExpires = new Date(active.expiresAt);
        newExpires.setDate(
          newExpires.getDate() + durationDays,
        );

        subscription =
          await tx.subscription.update({
            where: {
              id: active.id,
            },
            data: {
              expiresAt: newExpires,
              status: SubscriptionStatus.ACTIVE,
              isTrial: false,
              vpnSyncPending: true,
            },
          });

        mode = 'EXTENDED';
      } else {
        const expired =
          await tx.subscription.findFirst({
            where: {
              userId: payment.userId,
              plan: payment.plan,
              OR: [
                {
                  status:
                    SubscriptionStatus.EXPIRED,
                },
                {
                  expiresAt: {
                    lte: now,
                  },
                },
              ],
            },
            orderBy: {
              createdAt: 'desc',
            },
          });

        if (expired) {
          subscription =
            await tx.subscription.update({
              where: {
                id: expired.id,
              },
              data: {
                status: SubscriptionStatus.ACTIVE,
                startsAt: now,
                expiresAt,
                isTrial: false,
                vpnSyncPending: true,
              },
            });

          mode = 'RESTORED';
        } else {
          subscription =
            await tx.subscription.create({
              data: {
                userId: payment.userId,
                plan: payment.plan,
                status: SubscriptionStatus.ACTIVE,
                uuid: randomUUID(),
                subToken:
                  randomBytes(24).toString('hex'),
                startsAt: now,
                expiresAt,
                isTrial: false,
                vpnSyncPending: true,
              },
            });

          mode = 'CREATED';
        }
      }

      const updatedPayment =
        await tx.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            appliedSubscriptionId:
              subscription.id,
          },
        });

      return {
        payment: updatedPayment,
        applied: true,
        subscriptionId: subscription.id,
        mode,
      };
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      ),
    );

  if (
    result.applied &&
    result.subscriptionId &&
    result.mode
  ) {
    try {
      await this.subscriptions.syncSubscriptionState(
        result.subscriptionId,
      );

      await this.prisma.subscription.updateMany({
        where: {
          id: result.subscriptionId,
          vpnSyncPending: true,
        },
        data: {
          vpnSyncPending: false,
        },
      });
    } catch (error) {
      /*
       * PostgreSQL уже является источником истины.
       *
       * vpnSyncPending остаётся true,
       * поэтому общий recovery-cron позже
       * повторит абсолютную синхронизацию
       * Xray/H1Cloud из состояния БД.
       */
      this.logger.error(
        `Payment ${paymentId} VPN sync failed after DB commit: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    this.logger.log(
      `Manual payment ${paymentId} approved and applied to subscription ${result.subscriptionId}`,
    );
  }

  return result;
}
}
