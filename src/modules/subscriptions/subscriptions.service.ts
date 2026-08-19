import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { XrayService } from "../xray/xray.service";
import {
  type H1Client,
  type H1CloudNodeKey,
  H1CloudService,
} from "../h1cloud/h1cloud.service";
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

  private readonly h1Nodes: ReadonlyArray<{
    key: H1CloudNodeKey;
    name: string;
  }> = [
    { key: "FI1", name: "🇫🇮 Finland" },
    { key: "ES1", name: "🇪🇸 Spain" },
    { key: "PL1", name: "🇵🇱 Poland" },
    { key: "CH1", name: "🇨🇭 Switzerland" },
    { key: "SE1", name: "🇸🇪 Sweden" },
    { key: "NL1", name: "🇳🇱 Netherlands" },
  ];

  private getConfiguredH1Nodes() {
    return this.h1Nodes.filter((node) => this.h1cloud.isConfigured(node.key));
  }

  private getRemainingDays(expiresAt: Date) {
    return Math.max(
      1,
      Math.ceil((expiresAt.getTime() - Date.now()) / 86400000),
    );
  }

  private async saveH1CloudClient(
    nodeKey: H1CloudNodeKey,
    subscriptionId: string,
    client: H1Client,
  ) {
    const remoteLink = this.h1cloud.getPrimaryLink(client);

    return this.prisma.h1CloudClient.upsert({
      where: {
        subscriptionId_nodeKey: {
          subscriptionId,
          nodeKey,
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
        nodeKey,
        remoteName: client.name,
        remoteUuid: client.uuid,
        remoteLink,
        remoteSubUrl: client.sub_url || null,
      },
    });
  }

  private async provisionH1CloudNode(
    nodeKey: H1CloudNodeKey,
    subscription: {
      id: string;
      expiresAt: Date;
    },
  ) {
    const client = await this.h1cloud.createForSubscription(
      subscription.id,
      this.getRemainingDays(subscription.expiresAt),
      nodeKey,
    );

    return this.saveH1CloudClient(nodeKey, subscription.id, client);
  }

  private async provisionH1Cloud(subscription: {
  id: string;
  expiresAt: Date;
}) {
  for (const node of this.getConfiguredH1Nodes()) {
    try {
      await this.provisionH1CloudNode(node.key, subscription);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `H1Cloud provision failed for ${node.key} subscription ${subscription.id}: ${message}`,
      );
    }
  }
}

  private async extendH1Cloud(
  subscriptionId: string,
  extensionDays: number,
  expiresAt: Date,
) {
  const createDays = this.getRemainingDays(expiresAt);

  for (const node of this.getConfiguredH1Nodes()) {
    try {
      const client = await this.h1cloud.extendForSubscription(
        subscriptionId,
        extensionDays,
        node.key,
        createDays,
      );

      await this.saveH1CloudClient(
        node.key,
        subscriptionId,
        client,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `H1Cloud extend failed for ${node.key} subscription ${subscriptionId}: ${message}`,
      );
    }
  }
}

  private async removeH1Cloud(subscriptionId: string) {
  const clients = await this.prisma.h1CloudClient.findMany({
    where: {
      subscriptionId,
    },
    select: {
      nodeKey: true,
    },
  });

  let ok = 0;
  let fail = 0;

  for (const client of clients) {
    try {
      await this.h1cloud.deleteForSubscription(
        subscriptionId,
        client.nodeKey as H1CloudNodeKey
      );

      await this.prisma.h1CloudClient.deleteMany({
        where: {
          subscriptionId,
          nodeKey: client.nodeKey,
        },
      });

      ok++;
    } catch (error) {
      fail++;

      const message =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `H1Cloud remove failed for ${client.nodeKey} subscription ${subscriptionId}: ${message}`,
      );
    }
  }

  return {
    total: clients.length,
    ok,
    fail,
  };
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

  async getValidSubscriptionByUuid(uuid: string) {
    const now = new Date();

    return this.prisma.subscription.findFirst({
      where: {
        uuid,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
        },
        expiresAt: {
          gt: now,
        },
        user: {
          isBlocked: false,
        },
      },
      select: {
        id: true,
        uuid: true,
      },
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
      await this.extendH1Cloud(updated.id, days, updated.expiresAt);
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
      status: {
        in: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIAL,
        ],
      },
      expiresAt: {
        lte: now,
      },
    },
  });

  if (overdue.length === 0) {
    return 0;
  }

  let expired = 0;

  for (const sub of overdue) {
    let cleanupFailed = false;

    try {
      await this.xray.removeUserFromPlanNodes({
        uuid: sub.uuid,
        plan: sub.plan,
      });
    } catch (error) {
      cleanupFailed = true;

      const message =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Xray remove failed for subscription ${sub.id}: ${message}`,
      );
    }

    if (sub.plan === PlanType.STANDARD) {
      const h1Result = await this.removeH1Cloud(sub.id);

      if (h1Result.fail > 0) {
        cleanupFailed = true;

        this.logger.warn(
          `H1Cloud cleanup incomplete for subscription ${sub.id}: total=${h1Result.total} ok=${h1Result.ok} fail=${h1Result.fail}`,
        );
      }
    }

    if (cleanupFailed) {
      this.logger.warn(
        `Subscription ${sub.id} remains ${sub.status}; cleanup will be retried`,
      );

      continue;
    }

    try {
      await this.prisma.subscription.update({
        where: {
          id: sub.id,
        },
        data: {
          status: SubscriptionStatus.EXPIRED,
        },
      });

      expired++;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Failed to mark subscription ${sub.id} as expired: ${message}`,
      );
    }
  }

  if (expired > 0) {
    this.logger.log(
      `Expired ${expired} subscription(s)`,
    );
  }

  return expired;
}

  private async countExpectedH1CloudClients() {
    return this.prisma.subscription.count({
      where: {
        plan: PlanType.STANDARD,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
        },
        expiresAt: { gt: new Date() },
        user: { isBlocked: false },
      },
    });
  }

  async getH1CloudMonitoringStatus(nodeKey: H1CloudNodeKey = "FI1"): Promise<{
    apiOk: boolean;
    clients: number;
    online: number;
    expected: number;
  }> {
    const [status, remoteClients, expected] = await Promise.all([
      this.h1cloud.status(nodeKey),
      this.h1cloud.getClients(nodeKey),
      this.countExpectedH1CloudClients(),
    ]);

    return {
      apiOk: status.ok === true,
      clients: remoteClients.length,
      online: remoteClients.filter((client) => client.online).length,
      expected,
    };
  }

  async getH1CloudMonitoringStatuses() {
    const expected =
      await this.countExpectedH1CloudClients();

    return Promise.all(
      this.getConfiguredH1Nodes().map(
        async (node) => {
          const startedAt = Date.now();

          try {
            const [
              status,
              remoteClients,
              inboundResult,
            ] = await Promise.all([
              this.h1cloud.status(node.key),
              this.h1cloud.getClients(node.key),
              this.h1cloud.getInbounds(node.key),
            ]);

            const latencyMs =
              Date.now() - startedAt;

            const wsInbound =
  inboundResult.inbounds.find(
    (item) =>
      String(item.network || '').toLowerCase() === 'ws',
  ) || null;

const realityInbound =
  inboundResult.inbounds.find(
    (item) =>
      String(item.security || '').toLowerCase() === 'reality',
  ) || null;

const inbound =
  wsInbound ||
  realityInbound ||
  inboundResult.inbounds[0] ||
  null;

            const trafficBytes =
              remoteClients.reduce(
                (sum, client) =>
                  sum +
                  Number(
                    client.traffic_used_bytes || 0,
                  ),
                0,
              );

            const devices =
              remoteClients.reduce(
                (sum, client) =>
                  sum +
                  Number(
                    client.devices_count || 0,
                  ),
                0,
              );

            const deviceLimit =
              remoteClients.reduce(
                (sum, client) =>
                  sum +
                  Number(
                    client.device_limit || 0,
                  ),
                0,
              );

            const expirations =
              remoteClients
                .filter(
                  (client) =>
                    String(
                      client.status,
                    ).toUpperCase() ===
                    "ACTIVE",
                )
                .map((client) =>
                  Number(
                    client.expires_at || 0,
                  ),
                )
                .filter(Boolean)
                .sort((a, b) => a - b);

            const inboundEnabled =
              inbound === null
                ? false
                : inbound.enabled ??
                  inbound.active ??
                  [
                    "active",
                    "enabled",
                    "on",
                    "true",
                  ].includes(
                    String(
                      inbound.status || "",
                    ).toLowerCase(),
                  );

            return {
              nodeKey: node.key,
              name: node.name,
              apiOk: status.ok === true,
              latencyMs,
              clients: remoteClients.length,
              active:
                status.clients?.active ??
                remoteClients.filter(
                  (client) =>
                    String(
                      client.status,
                    ).toUpperCase() ===
                    "ACTIVE",
                ).length,
              expired:
                status.clients?.expired ?? 0,
              banned:
                status.clients?.banned ?? 0,
              online: remoteClients.filter(
                (client) => client.online,
              ).length,
              expected,
              trafficBytes,
              devices,
              deviceLimit,
              nearestExpiry:
                expirations[0]
                  ? new Date(
                      expirations[0] * 1000,
                    ).toISOString()
                  : null,
              domain: status.domain || null,
              version: status.version || null,
              transportMode:
                status.transport?.mode || null,
              egressMode:
                status.egress?.mode || null,
              realityEnabled:
                status.reality?.enabled === true,
              inbound: inbound
                ? {
                    tag: inbound.tag,
                    protocol: inbound.protocol,
                    network: inbound.network,
                    security: inbound.security,
                    port: inbound.port,
                    enabled: inboundEnabled,
                  }
                : null,
              error: null,
            };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : String(error);

            this.logger.warn(
              `H1Cloud monitoring unavailable for ${node.key}: ${message}`,
            );

            return {
              nodeKey: node.key,
              name: node.name,
              apiOk: false,
              latencyMs:
                Date.now() - startedAt,
              clients: 0,
              active: 0,
              expired: 0,
              banned: 0,
              online: 0,
              expected,
              trafficBytes: 0,
              devices: 0,
              deviceLimit: 0,
              nearestExpiry: null,
              domain: null,
              version: null,
              transportMode: null,
              egressMode: null,
              realityEnabled: false,
              inbound: null,
              error: message,
            };
          }
        },
      ),
    );
  }

  async recoverMissingH1CloudClients() {
    let total = 0;
    let ok = 0;
    let fail = 0;

    for (const node of this.getConfiguredH1Nodes()) {
      const missing = await this.prisma.subscription.findMany({
        where: {
          plan: PlanType.STANDARD,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: new Date() },
          user: { isBlocked: false },
          h1CloudClients: {
            none: {
              nodeKey: node.key,
            },
          },
        },
      });

      total += missing.length;

      for (const sub of missing) {
        try {
          await this.provisionH1CloudNode(node.key, sub);
          ok++;
        } catch (error) {
          fail++;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `H1Cloud recovery failed for ${node.key} subscription ${sub.id}: ${message}`,
          );
        }
      }
    }

    return { total, ok, fail };
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

    const links = nodes.flatMap((node) => {
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

      if (node.name.toLowerCase().includes("germany")) {
        const mainName = encodeURIComponent("🇩🇪 Germany MAIN");
        const xhttpName = encodeURIComponent("🇩🇪 Germany XHTTP");
        const wsName = encodeURIComponent("🇩🇪 Germany WS");
        const fastName = encodeURIComponent("🇩🇪 Germany FAST");

        const main =
          `vless://${sub.uuid}@130.17.24.143:443` +
          `?encryption=none` +
          `&flow=xtls-rprx-vision` +
          `&security=reality` +
          `&sni=www.cloudflare.com` +
          `&fp=chrome` +
          `&pbk=aTv2LVdB1nIybUlvhXGuAY4I6eq-eWATkYIhHo3y9Qo` +
          `&sid=933c83a3` +
          `&type=tcp` +
          `&headerType=none` +
          `#${mainName}`;

        const xhttp =
          `vless://${sub.uuid}@130.17.24.143:445` +
          `?encryption=none` +
          `&security=reality` +
          `&sni=www.cloudflare.com` +
          `&fp=chrome` +
          `&pbk=aTv2LVdB1nIybUlvhXGuAY4I6eq-eWATkYIhHo3y9Qo` +
          `&sid=933c83a3` +
          `&type=xhttp` +
          `&path=${encodeURIComponent("/4steps-xhttp")}` +
          `#${xhttpName}`;

        const ws =
          `vless://${sub.uuid}@130.17.24.143:444` +
          `?encryption=none` +
          `&security=none` +
          `&type=ws` +
          `&host=ws-de1.4stepsvpn.ru` +
          `&path=${encodeURIComponent("/ws-test")}` +
          `#${wsName}`;

        const fast =
          `hy2://${sub.uuid}@hy-de1.4stepsvpn.ru:443/` +
          `?sni=hy-de1.4stepsvpn.ru` +
          `#${fastName}`;

        return [main, xhttp, ws, fast];
      }

      return [
        `vless://${sub.uuid}@${node.host}:${node.port}` +
          `?encryption=none&flow=xtls-rprx-vision&security=reality` +
          `&sni=${node.sni}&fp=${node.fingerprint}&pbk=${node.publicKey}&sid=${node.shortId}` +
          `&type=tcp&headerType=none&xtls=2#${name}`,
      ];
    });

    if (sub.id) {
      const h1Links = await this.prisma.h1CloudClient.findMany({
        where: {
          subscriptionId: sub.id,
        },
        select: {
          nodeKey: true,
          remoteUuid: true,
          remoteLink: true,
        },
      });

      const linksByNode = new Map(
        h1Links.map((item) => [item.nodeKey, item]),
      );

      for (const node of this.h1Nodes) {
        const h1Client = linksByNode.get(node.key);

        if (!h1Client?.remoteLink) continue;

        const name = encodeURIComponent(node.name);

        if (node.key === "CH1" && h1Client.remoteUuid) {
          const mainName = encodeURIComponent("🇨🇭 Switzerland MAIN");
          const xhttpName = encodeURIComponent("🇨🇭 Switzerland XHTTP");
          const wsName = encodeURIComponent("🇨🇭 Switzerland WS");

          try {
            const remoteClient = await this.h1cloud.getClientByName(
              `sub_${sub.id}`,
              "CH1",
            );

            const mainLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_0f67f5820b",
            )?.link;

            if (mainLink) {
              const mainBase = mainLink.split("#")[0];
              links.push(`${mainBase}#${mainName}`);
            }

            const xhttpLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_d0aac15723",
            )?.link;

            if (xhttpLink) {
              const xhttpBase = xhttpLink.split("#")[0];
              links.push(`${xhttpBase}#${xhttpName}`);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Switzerland MAIN/XHTTP links unavailable for subscription ${sub.id}: ${message}`,
            );
          }

          links.push(
            `vless://${h1Client.remoteUuid}@ch1.4stepsvpn.ru:25054` +
            `?encryption=none&security=none` +
            `&type=ws&host=ws-ch1.4stepsvpn.ru` +
            `&path=${encodeURIComponent("/ws-test")}` +
            `#${wsName}`,
          );

          continue;
        }

        if (node.key === "NL1" && h1Client.remoteUuid) {
          const wsName = encodeURIComponent("🇳🇱 Netherlands WS");

          links.push(
            `vless://${h1Client.remoteUuid}@nl1.4stepsvpn.ru:25127` +
            `?encryption=none&security=none` +
            `&type=ws&host=ws-nl1.4stepsvpn.ru` +
            `&path=${encodeURIComponent("/ws-test")}` +
            `#${wsName}`,
          );

          continue;
        }

        if (node.key === "ES1" && h1Client.remoteUuid) {
          const mainName = encodeURIComponent("🇪🇸 Spain MAIN");
          const xhttpName = encodeURIComponent("🇪🇸 Spain XHTTP");
          const wsName = encodeURIComponent("🇪🇸 Spain WS");

          links.push(
            `vless://${h1Client.remoteUuid}@es1.4stepsvpn.ru:25487` +
            `?encryption=none&security=reality&type=tcp` +
            `&sni=www.microsoft.com&fp=chrome` +
            `&pbk=f2Upi-L-eWMy5ID7W2MjX7dueWhq7rVrYyUsA-_u0Sg` +
            `&sid=b7b834aac1aaf266&spx=%2F` +
            `#${mainName}`,
          );

          try {
            const remoteClient = await this.h1cloud.getClientByName(
              `sub_${sub.id}`,
              "ES1",
            );

            const xhttpLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_f1b9465174",
            )?.link;

            if (xhttpLink) {
              const xhttpBase = xhttpLink.split("#")[0];
              links.push(`${xhttpBase}#${xhttpName}`);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Spain XHTTP link unavailable for subscription ${sub.id}: ${message}`,
            );
          }

          links.push(
            `vless://${h1Client.remoteUuid}@es1.4stepsvpn.ru:25488` +
            `?encryption=none&security=none` +
            `&type=ws&host=ws-es1.4stepsvpn.ru` +
            `&path=${encodeURIComponent("/ws-test")}` +
            `#${wsName}`,
          );

          continue;
        }

        if (node.key === "PL1" && h1Client.remoteUuid) {
          const mainName = encodeURIComponent("🇵🇱 Poland MAIN");
          const xhttpName = encodeURIComponent("🇵🇱 Poland XHTTP");
          const wsName = encodeURIComponent("🇵🇱 Poland WS");

          try {
            const remoteClient = await this.h1cloud.getClientByName(
              `sub_${sub.id}`,
              "PL1",
            );

            const mainLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_a1e9039f1e",
            )?.link;

            if (mainLink) {
              const mainBase = mainLink.split("#")[0];
              links.push(`${mainBase}#${mainName}`);
            }

            const xhttpLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_cb423d6ea6",
            )?.link;

            if (xhttpLink) {
              const xhttpBase = xhttpLink.split("#")[0];
              links.push(`${xhttpBase}#${xhttpName}`);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Poland MAIN/XHTTP links unavailable for subscription ${sub.id}: ${message}`,
            );
          }

          links.push(
            `vless://${h1Client.remoteUuid}@pl1.4stepsvpn.ru:26548` +
            `?encryption=none&security=none` +
            `&type=ws&host=ws-pl1.4stepsvpn.ru` +
            `&path=${encodeURIComponent("/ws-test")}` +
            `#${wsName}`,
          );

          continue;
        }

        if (node.key === "SE1" && h1Client.remoteUuid) {
          const mainName = encodeURIComponent("🇸🇪 Sweden MAIN");
          const xhttpName = encodeURIComponent("🇸🇪 Sweden XHTTP");
          const wsName = encodeURIComponent("🇸🇪 Sweden WS");

          links.push(
            `vless://${h1Client.remoteUuid}@se1.4stepsvpn.ru:25234` +
            `?encryption=none&security=reality&type=tcp` +
            `&sni=www.cloudflare.com&fp=chrome` +
            `&pbk=zS3Jxep7dgx-y7HjpubrT5oULEzdhwFTXbsvDhbSQGk` +
            `&sid=94f138957076ee54&spx=%2F` +
            `#${mainName}`,
          );

          try {
            const remoteClient = await this.h1cloud.getClientByName(
              `sub_${sub.id}`,
              "SE1",
            );

            const xhttpLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_61c070c275",
            )?.link;

            if (xhttpLink) {
              const xhttpBase = xhttpLink.split("#")[0];
              links.push(`${xhttpBase}#${xhttpName}`);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Sweden XHTTP link unavailable for subscription ${sub.id}: ${message}`,
            );
          }

          links.push(
            `vless://${h1Client.remoteUuid}@se1.4stepsvpn.ru:25235` +
            `?encryption=none&security=none` +
            `&type=ws&host=ws-se1.4stepsvpn.ru` +
            `&path=${encodeURIComponent("/ws-test")}` +
            `#${wsName}`,
          );

          continue;
        }

        if (node.key === "FI1" && h1Client.remoteUuid) {
          const mainName = encodeURIComponent("🇫🇮 Finland MAIN");
          const xhttpName = encodeURIComponent("🇫🇮 Finland XHTTP");
          const wsName = encodeURIComponent("🇫🇮 Finland WS");

          try {
            const remoteClient = await this.h1cloud.getClientByName(
              `sub_${sub.id}`,
              "FI1",
            );

            const mainLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_7aac5e6b12",
            )?.link;

            if (mainLink) {
              const mainBase = mainLink.split("#")[0];
              links.push(`${mainBase}#${mainName}`);
            }

            const xhttpLink = remoteClient?.inbound_links?.find(
              (inbound) => inbound.id === "ib_cc89fe9508",
            )?.link;

            if (xhttpLink) {
              const xhttpBase = xhttpLink.split("#")[0];
              links.push(`${xhttpBase}#${xhttpName}`);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Finland MAIN/XHTTP links unavailable for subscription ${sub.id}: ${message}`,
            );
          }

          links.push(
            `vless://${h1Client.remoteUuid}@fi1.4stepsvpn.ru:25827` +
            `?encryption=none&security=none` +
            `&type=ws&host=ws-fi1.4stepsvpn.ru` +
            `&path=${encodeURIComponent("/ws-test")}` +
            `#${wsName}`,
          );

          continue;
        }

        const base = h1Client.remoteLink.split("#")[0];
        links.push(`${base}#${name}`);
      }
    }

    return links;
  }
}
