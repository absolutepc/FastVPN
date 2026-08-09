import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { XrayService } from '../xray/xray.service';
import { PlanType, SubscriptionStatus } from '@prisma/client';
import { randomUUID, randomBytes } from 'crypto';

const TRIAL_DAYS = 7;
const REFERRAL_BONUS_DAYS = 7;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly xray: XrayService,
  ) {}

  async createSubscription(params: {
    userId: string;
    plan: PlanType;
    days: number;
    isTrial?: boolean;
  }) {
    if (params.plan === PlanType.PREMIUM) {
      const can = await this.xray.canAcceptPremium();
      if (!can) {
        throw new Error('PREMIUM_FULL');
      }
    }

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

    await this.xray.addUserToPlanNodes({
      uuid: sub.uuid,
      plan: sub.plan,
    });

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

  async getLatestSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

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

    const wasExpired = sub.expiresAt <= new Date() || sub.status === SubscriptionStatus.EXPIRED;

    const base = sub.expiresAt > new Date() ? sub.expiresAt : new Date();
    const newExpires = new Date(base);
    newExpires.setDate(newExpires.getDate() + days);

    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        expiresAt: newExpires,
        status:
          sub.status === SubscriptionStatus.TRIAL
            ? SubscriptionStatus.TRIAL
            : SubscriptionStatus.ACTIVE,
      },
    });

    if (wasExpired) {
      await this.xray.addUserToPlanNodes({
        uuid: updated.uuid,
        plan: updated.plan,
      });
    }

    return updated;
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

  async expireOverdueSubscriptions() {
    const now = new Date();

    const overdue = await this.prisma.subscription.findMany({
      where: {
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
        expiresAt: { lte: now },
      },
    });

    if (overdue.length === 0) return 0;

    await this.prisma.subscription.updateMany({
      where: { id: { in: overdue.map((s) => s.id) } },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    for (const sub of overdue) {
      await this.xray.removeUserFromPlanNodes({
        uuid: sub.uuid,
        plan: sub.plan,
      });
    }

    this.logger.log(`Expired ${overdue.length} subscription(s)`);
    return overdue.length;
  }

  async buildSubscriptionLinks(sub: { uuid: string; plan: PlanType }): Promise<string[]> {
    const nodes = await this.prisma.node.findMany({
      where: {
        isActive: true,
        type: sub.plan === PlanType.PREMIUM ? 'PREMIUM' : 'STANDARD',
      },
    });

    if (nodes.length === 0) {
      return [
        `vless://${sub.uuid}@example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.cloudflare.com&fp=chrome&pbk=PLACEHOLDER&sid=0000000000000000&type=tcp#4StepsVPN-Stub`,
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
