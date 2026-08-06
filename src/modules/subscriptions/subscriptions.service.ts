import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanType, SubscriptionStatus } from '@prisma/client';
import { randomUUID, randomBytes } from 'crypto';

const TRIAL_DAYS = 7;
const REFERRAL_BONUS_DAYS = 7;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Создать новую подписку */
  async createSubscription(params: {
    userId: string;
    plan: PlanType;
    days: number;
    isTrial?: boolean;
  }) {
    const startsAt = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setDate(expiresAt.getDate() + params.days);

    const sub = await this.prisma.subscription.create({
      data: {
        userId: params.userId,
        plan: params.plan,
        status: params.isTrial ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
        uuid: randomUUID(),
        subToken: randomBytes(24).toString('hex'),
        startsAt,
        expiresAt,
        isTrial: params.isTrial ?? false,
      },
    });

    this.logger.log(
      `Subscription created: user=${params.userId} plan=${params.plan} days=${params.days} trial=${!!params.isTrial}`,
    );

    // TODO: добавить UUID на ноды через Xray API

    return sub;
  }

  /** Активная подписка пользователя (не истёкшая) */
  async getActiveSubscription(userId: string) {
    const now = new Date();
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
        expiresAt: { gt: now },
      },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /** Продлить существующую подписку на N дней */
  async extendSubscription(subscriptionId: string, days: number) {
    const sub = await this.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });

    const base = sub.expiresAt > new Date() ? sub.expiresAt : new Date();
    const newExpires = new Date(base);
    newExpires.setDate(newExpires.getDate() + days);

    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        expiresAt: newExpires,
        // если была TRIAL и продлеваем — оставляем TRIAL, иначе ACTIVE
        status: sub.status === SubscriptionStatus.TRIAL ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
      },
    });
  }

  /**
   * Реферальный бонус:
   * - приглашённому: 7 дней STANDARD trial
   * - пригласившему: +7 дней только к STANDARD (или создать STANDARD trial, если нет активной)
   * - PREMIUM бонус не получает
   */
  async processReferralBonus(inviteeId: string, referrerId: string) {
    // 1. Приглашённый — trial Стандарт
    const inviteeActive = await this.getActiveSubscription(inviteeId);
    if (!inviteeActive) {
      await this.createSubscription({
        userId: inviteeId,
        plan: PlanType.STANDARD,
        days: TRIAL_DAYS,
        isTrial: true,
      });
      this.logger.log(`Trial granted to invitee ${inviteeId}`);
    }

    // 2. Пригласивший
    const referrerSub = await this.getActiveSubscription(referrerId);

    if (referrerSub) {
      if (referrerSub.plan === PlanType.PREMIUM) {
        // Премиум — бонус не даём
        this.logger.log(`Referrer ${referrerId} is PREMIUM — no bonus`);
        return { inviteeTrial: !inviteeActive, referrerBonus: false };
      }

      // Стандарт — +7 дней
      await this.extendSubscription(referrerSub.id, REFERRAL_BONUS_DAYS);
      this.logger.log(`+${REFERRAL_BONUS_DAYS} days for referrer ${referrerId}`);
      return { inviteeTrial: !inviteeActive, referrerBonus: true };
    }

    // Нет активной подписки — даём 7 дней Стандарт
    await this.createSubscription({
      userId: referrerId,
      plan: PlanType.STANDARD,
      days: REFERRAL_BONUS_DAYS,
      isTrial: true,
    });
    this.logger.log(`Trial created for referrer ${referrerId} (no active sub)`);
    return { inviteeTrial: !inviteeActive, referrerBonus: true };
  }
}
