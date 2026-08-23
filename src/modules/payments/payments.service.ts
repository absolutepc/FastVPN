import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  PlanType,
  PaymentStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';

const PLAN_PRICES: Record<PlanType, number> = {
  STANDARD: 30000,
  PREMIUM: 60000,
};

const PLAN_DAYS = 30;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly shopId: string;
  private readonly secretKey: string;
  private readonly returnUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {
    this.shopId = this.config.get<string>('YOOKASSA_SHOP_ID') || '';
    this.secretKey = this.config.get<string>('YOOKASSA_SECRET_KEY') || '';
    this.returnUrl =
      this.config.get<string>('YOOKASSA_RETURN_URL') || 'https://t.me/';
  }

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

  getPrice(plan: PlanType): number {
    return PLAN_PRICES[plan];
  }

  async createPayment(params: { userId: string; plan: PlanType; description?: string }) {
    if (!this.shopId || !this.secretKey) {
      throw new Error('YooKassa is not configured');
    }

    const amount = this.getPrice(params.plan);
    const amountValue = (amount / 100).toFixed(2);
    const idempotenceKey = randomUUID();

    const payment = await this.prisma.payment.create({
      data: {
        userId: params.userId,
        amount,
        currency: 'RUB',
        plan: params.plan,
        status: PaymentStatus.PENDING,
        description:
          params.description ||
          `4StepsVPN — ${params.plan === PlanType.PREMIUM ? 'Премиум' : 'Стандарт'} 30 дн.`,
      },
    });

    const body = {
      amount: { value: amountValue, currency: 'RUB' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: this.returnUrl,
      },
      description: payment.description,
      metadata: {
        payment_id: payment.id,
        user_id: params.userId,
        plan: params.plan,
      },
    };

    const auth = Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64');

    const res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`YooKassa create failed: ${res.status} ${errText}`);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.CANCELLED },
      });
      throw new Error('YooKassa payment creation failed');
    }

    const data = (await res.json()) as {
      id: string;
      status: string;
      confirmation?: { confirmation_url?: string };
    };

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerPaymentId: data.id,
        paymentProvider: 'YOOKASSA',
      },
    });

    return {
      paymentId: payment.id,
      yookassaId: data.id,
      confirmationUrl: data.confirmation?.confirmation_url,
      amount: amountValue,
    };
  }

  async handleSucceeded(providerPaymentId: string, metadata?: Record<string, string>) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          { providerPaymentId },
          ...(metadata?.payment_id ? [{ id: metadata.payment_id }] : []),
        ],
      },
    });

    if (!payment) {
      this.logger.warn(`Payment not found for provider id ${providerPaymentId}`);
      return null;
    }

    if (payment.status === PaymentStatus.SUCCEEDED) {
      return payment;
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        providerPaymentId,
        paymentProvider: 'YOOKASSA',
      },
    });

    const active = await this.subscriptions.getActiveSubscription(payment.userId);

    if (active && active.plan === payment.plan) {
      await this.subscriptions.extendSubscription(active.id, PLAN_DAYS);
    } else {
      try {
        await this.subscriptions.createSubscription({
          userId: payment.userId,
          plan: payment.plan,
          days: PLAN_DAYS,
          isTrial: false,
        });
      } catch (e) {
        if (e instanceof Error && e.message === 'PREMIUM_FULL') {
          this.logger.error('Premium full on payment success — manual resolve needed');
        } else {
          throw e;
        }
      }
    }

    this.logger.log(`Payment ${payment.id} succeeded → subscription activated`);
    return payment;
  }

  async handleCanceled(providerPaymentId: string) {
    await this.prisma.payment.updateMany({
      where: { providerPaymentId, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.CANCELLED },
    });

 }
 async createManualPayment(params: {
  userId: string;
  plan: PlanType;
  bank: 'TBANK' | 'SBER';
}) {
  const amount = this.getPrice(params.plan);

  return this.prisma.payment.create({
    data: {
      userId: params.userId,
      amount,
      baseAmount: amount,
      feeAmount: 0,
      feePercent: 0,
      currency: 'RUB',
      plan: params.plan,
      status: PaymentStatus.PENDING,
      paymentMethod: 'MANUAL_SBP',
      paymentProvider: 'MANUAL',
      bank: params.bank,
      description: `4StepsVPN — Стандарт 30 дн. — ручная оплата`,
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

      const expiresAt = new Date(now);
      expiresAt.setDate(
        expiresAt.getDate() + PLAN_DAYS,
      );

      let subscription;
      let mode:
        | 'CREATED'
        | 'RESTORED'
        | 'EXTENDED';

      const active = await tx.subscription.findFirst({
        where: {
          userId: payment.userId,
          plan: payment.plan,
          status: {
            in: [
              SubscriptionStatus.ACTIVE,
              SubscriptionStatus.TRIAL,
            ],
          },
          expiresAt: {
            gt: now,
          },
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

      if (active) {
        const newExpires = new Date(active.expiresAt);
        newExpires.setDate(
          newExpires.getDate() + PLAN_DAYS,
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
      await this.subscriptions.syncPaymentSubscription(
        result.subscriptionId,
        PLAN_DAYS,
        result.mode,
      );
    } catch (error) {
      /*
       * PostgreSQL уже является источником истины.
       * Ошибка Xray/H1Cloud не должна отменять
       * подтверждённую оплату.
       *
       * Recovery-механизмы синхронизируют ноды позже.
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
