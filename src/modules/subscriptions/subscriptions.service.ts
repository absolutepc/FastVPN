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

  async getActiveSubscription(userId: string) {
    const now = new Date();
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
        expiresAt: { gt: now },
        user: { isBlocked: false },
      },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /** Проверка по subToken (для /sub/:token) */
  async getValidSubscriptionByToken(subToken: string) {
    const now = new Date();
    return this.prisma.subscription.findFirst({
      where: {
        subToken,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
        expiresAt: { gt: now },
        user: { isBlocked: false },
      },
      include: { user: true },
    });
  }

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
        status:
          sub.status === SubscriptionStatus.TRIAL
            ? SubscriptionStatus.TRIAL
            : SubscriptionStatus.ACTIVE,
      },
    });
  }

  async processReferralBonus(inviteeId: string, referrerId: string) {
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

    const referrerSub = await this.getActiveSubscription(referrerId);

    if (referrerSub) {
      if (referrerSub.plan === PlanType.PREMIUM) {
        this.logger.log(`Referrer ${referrerId} is PREMIUM — no bonus`);
        return { inviteeTrial: !inviteeActive, referrerBonus: false };
      }

      await this.extendSubscription(referrerSub.id, REFERRAL_BONUS_DAYS);
      this.logger.log(`+${REFERRAL_BONUS_DAYS} days for referrer ${referrerId}`);
      return { inviteeTrial: !inviteeActive, referrerBonus: true };
    }

    await this.createSubscription({
      userId: referrerId,
      plan: PlanType.STANDARD,
      days: REFERRAL_BONUS_DAYS,
      isTrial: true,
    });
    this.logger.log(`Trial created for referrer ${referrerId} (no active sub)`);
    return { inviteeTrial: !inviteeActive, referrerBonus: true };
  }

  /** Пометить истёкшие подписки как EXPIRED */
  async expireOverdueSubscriptions() {
    const now = new Date();

    const result = await this.prisma.subscription.updateMany({
      where: {
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
        expiresAt: { lte: now },
      },
      data: {
        status: SubscriptionStatus.EXPIRED,
      },
    });

    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} subscription(s)`);
      // TODO: удалить UUID с нод через Xray API
    }

    return result.count;
  }

  /**
   * Собрать список VLESS-ссылок для subscription.
   * Пока — заглушка из активных нод нужного типа.
   * Позже: реальные Reality-параметры + UUID пользователя.
   */
  async buildSubscriptionLinks(sub: {
    uuid: string;
    plan: PlanType;
  }): Promise<string[]> {
    const nodes = await this.prisma.node.findMany({
      where: {
        isActive: true,
        type: sub.plan === PlanType.PREMIUM ? 'PREMIUM' : 'STANDARD',
      },
    });

    if (nodes.length === 0) {
      // Fallback-заглушка, пока ноды не добавлены
      return [
        `vless://${sub.uuid}@example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.cloudflare.com&fp=chrome&pbk=PLACEHOLDER&sid=0000000000000000&type=tcp#AccessOne-Stub`,
      ];
    }

    return nodes.map((node) => {
      const name = encodeURIComponent(node.name);
      return (
        `vless://${sub.uuid}@${node.host}:${node.port}` +
        `?encryption=none&flow=xtls-rprx-vision&security=reality` +
        `&sni=${node.sni}&fp=${node.fingerprint}&pbk=${node.publicKey}&sid=${node.shortId}` +
        `&type=tcp#${name}`
      );
    });
  }
}
