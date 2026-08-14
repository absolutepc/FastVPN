import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PlanType, PaymentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

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
      data: { yookassaPaymentId: data.id },
    });

    return {
      paymentId: payment.id,
      yookassaId: data.id,
      confirmationUrl: data.confirmation?.confirmation_url,
      amount: amountValue,
    };
  }

  async handleSucceeded(yookassaPaymentId: string, metadata?: Record<string, string>) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          { yookassaPaymentId },
          ...(metadata?.payment_id ? [{ id: metadata.payment_id }] : []),
        ],
      },
    });

    if (!payment) {
      this.logger.warn(`Payment not found for yookassa id ${yookassaPaymentId}`);
      return null;
    }

    if (payment.status === PaymentStatus.SUCCEEDED) {
      return payment;
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        yookassaPaymentId,
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

  async handleCanceled(yookassaPaymentId: string) {
    await this.prisma.payment.updateMany({
      where: { yookassaPaymentId, status: PaymentStatus.PENDING },
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
      currency: 'RUB',
      plan: params.plan,
      status: PaymentStatus.PENDING,
      paymentMethod: 'MANUAL_SBP',
      bank: params.bank,
      description: `4StepsVPN — Стандарт 30 дн. — ручная оплата`,
    },
  });
}

async approveManualPayment(paymentId: string, adminTelegramId: string) {
  const payment = await this.prisma.payment.findUnique({
    where: { id: paymentId },
  });

  if (!payment) {
    throw new Error('PAYMENT_NOT_FOUND');
  }

  if (payment.status === PaymentStatus.SUCCEEDED) {
    return payment;
  }

  const updated = await this.prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: PaymentStatus.SUCCEEDED,
      reviewedAt: new Date(),
      reviewedBy: adminTelegramId,
    },
  });

  const active = await this.subscriptions.getActiveSubscription(payment.userId);

  if (active && active.plan === payment.plan) {
    await this.subscriptions.extendSubscription(active.id, PLAN_DAYS);
  } else {
    await this.subscriptions.createSubscription({
      userId: payment.userId,
      plan: payment.plan,
      days: PLAN_DAYS,
      isTrial: false,
    });
  }

  this.logger.log(`Manual payment ${paymentId} approved`);

  return updated;
}
}
