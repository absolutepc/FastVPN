import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { XrayService } from "../xray/xray.service";
import { H1CloudService } from "../h1cloud/h1cloud.service";
import { PlanType, SubscriptionStatus } from "@prisma/client";
import { randomUUID, randomBytes } from "crypto";

const TRIAL_DAYS = 7;
const REFERRAL_BONUS_DAYS = 7;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly xray: XrayService,
    private readonly h1cloud: H1CloudService,
  ) {}

  private readonly h1NodeKey = "FI1";

  private async provisionH1Cloud(subscription: {
    id: string;
    expiresAt: Date;
  }) {
    const now = new Date();

    const remainingMs = subscription.expiresAt.getTime() - now.getTime();

    const days = Math.max(1, Math.ceil(remainingMs / 86400000));

    const client = await this.h1cloud.createForSubscription(
      subscription.id,
      days,
    );

    const remoteLink = this.h1cloud.getPrimaryLink(client);

    return this.prisma.h1CloudClient.upsert({
      where: {
        subscriptionId_nodeKey: {
          subscriptionId: subscription.id,
          nodeKey: this.h1NodeKey,
        },
      },
      update: {
        remoteName: client.name,
        remoteUuid: client.uuid,
        remoteLink,
        remoteSubUrl: client.sub_url || null,
      },
      create: {
        subscriptionId: subscription.id,
        nodeKey: this.h1NodeKey,
        remoteName: client.name,
        remoteUuid: client.uuid,
        remoteLink,
        remoteSubUrl: client.sub_url || null,
      },
    });
  }

  private async extendH1Cloud(subscriptionId: string, days: number) {
    const client = await this.h1cloud.extendForSubscription(
      subscriptionId,
      days,
    );

    const remoteLink = this.h1cloud.getPrimaryLink(client);

    return this.prisma.h1CloudClient.upsert({
      where: {
        subscriptionId_nodeKey: {
          subscriptionId,
          nodeKey: this.h1NodeKey,
        },
      },
      update: {
        remoteName: client.name,
        remoteUuid: client.uuid,
        remoteLink,
        remoteSubUrl: client.sub_url || null,
      },
      create: {
        subscriptionId,
        nodeKey: this.h1NodeKey,
        remoteName: client.name,
        remoteUuid: client.uuid,
        remoteLink,
        remoteSubUrl: client.sub_url || null,
      },
    });
  }

  private async removeH1Cloud(subscriptionId: string) {
    await this.h1cloud.deleteForSubscription(subscriptionId);

    await this.prisma.h1CloudClient.deleteMany({
      where: {
        subscriptionId,
        nodeKey: this.h1NodeKey,
      },
    });
  }

  async createSubscription(params: {
    userId: string;
    plan: PlanType;
    days: number;
    isTrial?: boolean;
  }) {
    if (params.plan === PlanType.PREMIUM) {
      const can = await this.xray.canAcceptPremium();
      if (!can) {
        throw new Error("PREMIUM_FULL");
      }
    }

    const startsAt = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setDate(expiresAt.getDate() + params.days);

    // Ищем предыдущую ИСТЁКШУЮ подписку этого же тарифа.
    // Если она есть — сохраняем старые UUID и subToken.
    const expired = await this.prisma.subscription.findFirst({
      where: {
        userId: params.userId,
        plan: params.plan,
        status: SubscriptionStatus.EXPIRED,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (expired) {
      const restored = await this.prisma.subscription.update({
        where: {
          id: expired.id,
        },
        data: {
          status: params.isTrial
            ? SubscriptionStatus.TRIAL
            : SubscriptionStatus.ACTIVE,
          startsAt,
          expiresAt,
          isTrial: params.isTrial ?? false,
        },
      });

      await this.xray.addUserToPlanNodes({
        uuid: restored.uuid,
        plan: restored.plan,
      });

      if (restored.plan === PlanType.STANDARD) {
        await this.provisionH1Cloud(restored);
      }

      this.logger.log(
        `Subscription restored: user=${params.userId} plan=${params.plan} days=${params.days} uuid=${restored.uuid}`,
      );

      return restored;
    }

    // Первая подписка пользователя — создаём UUID и постоянный token.
    const sub = await this.prisma.subscription.create({
      data: {
        userId: params.userId,
        plan: params.plan,
        status: params.isTrial
          ? SubscriptionStatus.TRIAL
          : SubscriptionStatus.ACTIVE,
        uuid: randomUUID(),
        subToken: randomBytes(24).toString("hex"),
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

    if (sub.plan === PlanType.STANDARD) {
      await this.provisionH1Cloud(sub);
    }

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
      orderBy: { expiresAt: "desc" },
    });
  }

  async getLatestSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: {
        userId,
      },
      orderBy: {
        createdAt: "desc",
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

    const wasExpired =
      sub.expiresAt <= new Date() || sub.status === SubscriptionStatus.EXPIRED;

    const base = sub.expiresAt > new Date() ? sub.expiresAt : new Date();
    const newExpires = new Date(base);
    newExpires.setDate(newExpires.getDate() + days);

    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        expiresAt: newExpires,
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
      },
    });

    if (wasExpired) {
      await this.xray.addUserToPlanNodes({
        uuid: updated.uuid,
        plan: updated.plan,
      });
    }

    if (updated.plan === PlanType.STANDARD) {
      await this.extendH1Cloud(updated.id, days);
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
      this.logger.log(
        `+${REFERRAL_BONUS_DAYS} days for referrer ${referrerId}`,
      );
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

      if (sub.plan === PlanType.STANDARD) {
        await this.removeH1Cloud(sub.id);
      }
    }

    this.logger.log(`Expired ${overdue.length} subscription(s)`);
    return overdue.length;
  }

  async buildSubscriptionLinks(sub: {
    id?: string;
    uuid: string;
    plan: PlanType;
  }): Promise<string[]> {
    const nodes = await this.prisma.node.findMany({
      where: {
        isActive: true,
        type: sub.plan === PlanType.PREMIUM ? "PREMIUM" : "STANDARD",
      },
    });

    const links = nodes.map((node) => {
      const countryFlag = node.name.toLowerCase().includes("germany")
        ? "🇩🇪"
        : node.name.toLowerCase().includes("netherlands")
          ? "🇳🇱"
          : node.name.toLowerCase().includes("france")
            ? "🇫🇷"
            : node.name.toLowerCase().includes("finland")
              ? "🇫🇮"
              : node.name.toLowerCase().includes("sweden")
                ? "🇸🇪"
                : node.name.toLowerCase().includes("usa")
                  ? "🇺🇸"
                  : "🌐";

      const name = encodeURIComponent(`${countryFlag} ${node.name}`);
      return (
        `vless://${sub.uuid}@${node.host}:${node.port}` +
        `?encryption=none&flow=xtls-rprx-vision&security=reality` +
        `&sni=${node.sni}&fp=${node.fingerprint}&pbk=${node.publicKey}&sid=${node.shortId}` +
        `&type=tcp&headerType=none&xtls=2#${name}`
      );
    });

    if (sub.id) {
      const h1Links = await this.prisma.h1CloudClient.findMany({
        where: {
          subscriptionId: sub.id,
        },
        select: {
          remoteLink: true,
        },
      });

      links.push(
        ...h1Links.flatMap((item) => {
          if (!item.remoteLink) return [];

          const base = item.remoteLink.split("#")[0];
          const name = encodeURIComponent("🇫🇮 Finland");

          return [`${base}#${name}`];
        }),
      );
    }

    return links;
  }
}
