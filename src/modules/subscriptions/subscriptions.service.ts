import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { XrayService } from "../xray/xray.service";
import {
  type H1Client,
  type H1CloudNodeKey,
  H1CloudService,
} from "../h1cloud/h1cloud.service";
import {
  Device,
  PlanType,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
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

        if (
          !retryable ||
          attempt === attempts
        ) {
          throw error;
        }

        this.logger.warn(
          `Serializable subscription conflict; retry ${attempt}/${attempts}`,
        );
      }
    }

    throw new Error(
      'SERIALIZABLE_SUBSCRIPTION_RETRY_EXHAUSTED',
    );
  }


  private readonly h1Nodes: ReadonlyArray<{
    key: H1CloudNodeKey;
    name: string;
  }> = [
    { key: "FI1", name: "🇫🇮 Finland" },
    { key: "CH1", name: "🇨🇭 Switzerland" },
    { key: "NL1", name: "🇳🇱 Netherlands" },
    { key: "NLBS1", name: "🇳🇱 Netherlands БС" },
  ];

  private getMaintenanceH1Nodes(): Set<string> {
    return new Set(
      (process.env.H1CLOUD_MAINTENANCE_NODES || '')
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    );
  }

  private getConfiguredH1Nodes(options?: {
    includeMaintenance?: boolean;
  }) {
    const maintenance = this.getMaintenanceH1Nodes();

    return this.h1Nodes.filter((node) => {
      if (!this.h1cloud.isConfigured(node.key)) {
        return false;
      }

      if (
        options?.includeMaintenance !== true &&
        maintenance.has(node.key)
      ) {
        return false;
      }

      return true;
    });
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
    deviceId: string,
    client: H1Client,
  ) {
    const remoteLink = this.h1cloud.getPrimaryLink(client);

    return this.prisma.h1CloudClient.upsert({
      where: {
        deviceId_nodeKey: {
          deviceId,
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
        deviceId,
        nodeKey,
        remoteName: client.name,
        remoteUuid: client.uuid,
        remoteLink,
        remoteSubUrl: client.sub_url || null,
      },
    });
  }

  private async ensurePrimaryDevice(subscriptionId: string) {
    const subscription =
      await this.prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });

    return this.prisma.device.upsert({
      where: {
        subscriptionId_slot: {
          subscriptionId,
          slot: 1,
        },
      },
      update: {},
      create: {
        userId: subscription.userId,
        subscriptionId,
        uuid: subscription.uuid,
        subToken: subscription.subToken,
        slot: 1,
        name: 'Основное устройство',
        isActive: true,
        vpnSyncPending: false,
      },
    });
  }

  private async provisionH1CloudDeviceNode(
    nodeKey: H1CloudNodeKey,
    device: Device,
    expiresAt: Date,
  ) {
    const client =
      device.slot === 1
        ? await this.h1cloud.createForSubscription(
            device.subscriptionId,
            this.getRemainingDays(expiresAt),
            nodeKey,
          )
        : await this.h1cloud.createForDevice(
            device.id,
            this.getRemainingDays(expiresAt),
            nodeKey,
          );

    return this.saveH1CloudClient(
      nodeKey,
      device.subscriptionId,
      device.id,
      client,
    );
  }

  private async extendH1Cloud(
    subscriptionId: string,
    extensionDays: number,
    expiresAt: Date,
  ) {
    await this.ensurePrimaryDevice(subscriptionId);

    const createDays = this.getRemainingDays(expiresAt);
    const devices = await this.prisma.device.findMany({
      where: {
        subscriptionId,
        isActive: true,
      },
    });

    for (const device of devices) {
      for (const node of this.getConfiguredH1Nodes()) {
        try {
          const client =
            device.slot === 1
              ? await this.h1cloud.extendForSubscription(
                  subscriptionId,
                  extensionDays,
                  node.key,
                  createDays,
                )
              : await this.h1cloud.extendForDevice(
                  device.id,
                  extensionDays,
                  node.key,
                  createDays,
                );

          await this.saveH1CloudClient(
            node.key,
            subscriptionId,
            device.id,
            client,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `H1Cloud extend failed for ${node.key} device ${device.id}: ${message}`,
          );
        }
      }
    }
  }

  private async removeH1Cloud(subscriptionId: string) {
    const clients = await this.prisma.h1CloudClient.findMany({
      where: {
        subscriptionId,
      },
      select: {
        id: true,
        nodeKey: true,
        remoteName: true,
      },
    });

    let ok = 0;
    let fail = 0;
    const failedNodeKeys: string[] = [];

    for (const client of clients) {
      try {
        await this.h1cloud.deleteClient(
          client.remoteName,
          client.nodeKey as H1CloudNodeKey,
        );

        await this.prisma.h1CloudClient.delete({
          where: { id: client.id },
        });

        ok++;
      } catch (error) {
        fail++;
        failedNodeKeys.push(client.nodeKey);

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
      failedNodeKeys,
    };
  }

  private async finalizeSubscriptionVpnSync(
    subscriptionId: string,
  ) {
    try {
      await this.syncSubscriptionState(
        subscriptionId,
      );

      await this.prisma.subscription.updateMany({
        where: {
          id: subscriptionId,
          vpnSyncPending: true,
        },
        data: {
          vpnSyncPending: false,
        },
      });
    } catch (error) {
      this.logger.error(
        `Subscription ${subscriptionId} VPN sync failed after DB commit: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }
  }

  async createSubscription(params: {
    userId: string;
    plan: PlanType;
    days: number;
    isTrial?: boolean;
  }) {
    if (
      !Number.isInteger(params.days) ||
      params.days <= 0
    ) {
      throw new Error(
        'INVALID_SUBSCRIPTION_DAYS',
      );
    }

    const now = new Date();

    const existing =
      await this.prisma.subscription.findFirst({
        where: {
          userId: params.userId,
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

    if (existing) {
      if (existing.expiresAt <= now) {
        throw new Error(
          'ACTIVE_SUBSCRIPTION_EXPIRY_PENDING',
        );
      }

      if (existing.plan !== params.plan) {
        throw new Error(
          'ACTIVE_SUBSCRIPTION_PLAN_CONFLICT',
        );
      }

      await this.prisma.subscription.update({
        where: {
          id: existing.id,
        },
        data: {
          vpnSyncPending: true,
        },
      });

      await this.finalizeSubscriptionVpnSync(
        existing.id,
      );

      return this.prisma.subscription
        .findUniqueOrThrow({
          where: {
            id: existing.id,
          },
        });
    }

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
          vpnSyncPending: true,
        },
      });

      await this.finalizeSubscriptionVpnSync(
        restored.id,
      );

      this.logger.log(
        `Subscription restored: user=${params.userId} plan=${params.plan} days=${params.days} uuid=${restored.uuid}`,
      );

      return this.prisma.subscription
        .findUniqueOrThrow({
          where: {
            id: restored.id,
          },
        });
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
        vpnSyncPending: true,
      },
    });

    this.logger.log(
      `Subscription created: user=${params.userId} plan=${params.plan} days=${params.days} trial=${!!params.isTrial}`,
    );

    await this.finalizeSubscriptionVpnSync(
      sub.id,
    );

    return this.prisma.subscription
      .findUniqueOrThrow({
        where: {
          id: sub.id,
        },
      });
  }

  async syncPaymentSubscription(
    subscriptionId: string,
    days: number,
    mode: 'CREATED' | 'RESTORED' | 'EXTENDED',
  ) {
    const subscription =
      await this.prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });

    if (mode === 'EXTENDED') {
      if (subscription.plan === PlanType.STANDARD) {
        await this.extendH1Cloud(
          subscription.id,
          days,
          subscription.expiresAt,
        );
      }

      return subscription;
    }

    await this.syncSubscriptionState(subscription.id);

    return subscription;
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

  async getValidDeviceByToken(subToken: string) {
    const now = new Date();

    return this.prisma.device.findFirst({
      where: {
        subToken,
        isActive: true,
        vpnSyncPending: false,
        subscription: {
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: now },
          user: { isBlocked: false },
        },
      },
      include: {
        subscription: {
          include: { user: true },
        },
      },
    });
  }

  async getValidSubscriptionByUuid(uuid: string) {
    const now = new Date();

    const device = await this.prisma.device.findFirst({
      where: {
        uuid,
        isActive: true,
        vpnSyncPending: false,
        subscription: {
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: now },
          user: { isBlocked: false },
        },
      },
      select: {
        id: true,
        uuid: true,
      },
    });

    if (device) {
      return device;
    }

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

  async extendSubscription(
    subscriptionId: string,
    days: number,
  ) {
    if (
      !Number.isInteger(days) ||
      days <= 0
    ) {
      throw new Error(
        'INVALID_SUBSCRIPTION_EXTENSION_DAYS',
      );
    }

    const result =
      await this.withSerializableRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            const sub =
              await tx.subscription
                .findUniqueOrThrow({
                  where: {
                    id: subscriptionId,
                  },
                });

            const conflicting =
              await tx.subscription.findFirst({
                where: {
                  userId:
                    sub.userId,
                  id: {
                    not:
                      sub.id,
                  },
                  status: {
                    in: [
                      SubscriptionStatus.ACTIVE,
                      SubscriptionStatus.TRIAL,
                    ],
                  },
                },
                select: {
                  id:
                    true,
                },
              });

            if (conflicting) {
              throw new Error(
                'ACTIVE_SUBSCRIPTION_CONFLICT',
              );
            }

            const now =
              new Date();

            const wasExpired =
              sub.expiresAt <= now ||
              sub.status ===
                SubscriptionStatus.EXPIRED;

            const base =
              sub.expiresAt > now
                ? sub.expiresAt
                : now;

            const newExpires =
              new Date(base);

            newExpires.setDate(
              newExpires.getDate() + days,
            );

            const updated =
              await tx.subscription.update({
                where: {
                  id: subscriptionId,
                },
                data: {
                  expiresAt:
                    newExpires,
                  status:
                    SubscriptionStatus.ACTIVE,
                  isTrial:
                    false,
                  vpnSyncPending:
                    true,
                },
              });

            return {
              subscription:
                updated,
              wasExpired,
            };
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel
                .Serializable,
          },
        ),
      );

    const updated =
      result.subscription;

    /*
     * После commit выполняем абсолютную
     * синхронизацию из состояния БД.
     *
     * Это crash-safe: повтор recovery
     * не начисляет дополнительные дни.
     */
    await this.finalizeSubscriptionVpnSync(
      updated.id,
    );

    return this.prisma.subscription
      .findUniqueOrThrow({
        where: {
          id:
            updated.id,
        },
      });
  }

  async syncSubscriptionExpiry(
    subscriptionId: string,
  ) {
    const subscription =
      await this.prisma.subscription.findUniqueOrThrow({
        where: {
          id: subscriptionId,
        },
      });

    if (subscription.plan !== PlanType.STANDARD) {
      return subscription;
    }

    const active =
      subscription.expiresAt > new Date() &&
      (
        subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.TRIAL
      );

    if (!active) {
      const removed =
        await this.removeH1Cloud(subscription.id);

      if (removed.fail > 0) {
        throw new Error(
          `H1CLOUD_REMOVE_INCOMPLETE:${removed.failedNodeKeys.join(',')}`,
        );
      }

      return subscription;
    }

    await this.ensurePrimaryDevice(subscription.id);

    const devices = await this.prisma.device.findMany({
      where: {
        subscriptionId: subscription.id,
        isActive: true,
      },
    });

    let ok = 0;
    let fail = 0;
    const failedNodeKeys: string[] = [];

    for (const device of devices) {
      for (const node of this.getConfiguredH1Nodes()) {
        try {
          await this.provisionH1CloudDeviceNode(
            node.key,
            device,
            subscription.expiresAt,
          );
          ok++;
        } catch (error) {
          fail++;
          failedNodeKeys.push(node.key);
          this.logger.error(
            `H1Cloud sync failed for ${node.key} device ${device.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const provisioned = { ok, fail, failedNodeKeys };

    if (provisioned.fail > 0) {
      throw new Error(
        `H1CLOUD_SYNC_INCOMPLETE:${[
          ...new Set(provisioned.failedNodeKeys),
        ].join(',')}`,
      );
    }

    return subscription;
  }


  async syncSubscriptionState(
    subscriptionId: string,
  ) {
    const subscription =
      await this.prisma.subscription
        .findUniqueOrThrow({
          where: {
            id: subscriptionId,
          },
        });

    await this.ensurePrimaryDevice(subscription.id);

    const devices = await this.prisma.device.findMany({
      where: { subscriptionId: subscription.id },
    });

    const active =
      subscription.expiresAt >
        new Date() &&
      (
        subscription.status ===
          SubscriptionStatus.ACTIVE ||
        subscription.status ===
          SubscriptionStatus.TRIAL
      );

    /*
     * Xray sync делаем идемпотентным:
     * remove -> add.
     *
     * Поэтому повтор после crash не выдаст
     * пользователю дополнительные дни.
     */
    let removeFailures = 0;
    let addFailures = 0;

    for (const device of devices) {
      const removed = await this.xray.removeUserFromPlanNodes({
        uuid: device.uuid,
        plan: subscription.plan,
      });
      removeFailures += removed.fail;

      if (active && device.isActive) {
        const added = await this.xray.addUserToPlanNodes({
          uuid: device.uuid,
          plan: subscription.plan,
          skipCapacityCheck: true,
        });
        addFailures += added.fail;
      }
    }

    if (removeFailures > 0 || addFailures > 0) {
      throw new Error(
        `XRAY_SYNC_INCOMPLETE:remove=${removeFailures},add=${addFailures}`,
      );
    }

    /*
     * Для H1Cloud используем абсолютный
     * expiresAt из БД, а не повторный +N.
     *
     * Поэтому recovery после crash
     * не может начислить +7 повторно.
     */
    if (
      subscription.plan ===
      PlanType.STANDARD
    ) {
      await this.syncSubscriptionExpiry(
        subscription.id,
      );
    }

    return subscription;
  }

  async syncDeviceState(deviceId: string) {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
      include: { subscription: true },
    });

    const subscription = device.subscription;
    const active =
      device.isActive &&
      subscription.expiresAt > new Date() &&
      (subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.TRIAL);

    const removed = await this.xray.removeUserFromPlanNodes({
      uuid: device.uuid,
      plan: subscription.plan,
    });

    let addFailures = 0;
    if (active) {
      const added = await this.xray.addUserToPlanNodes({
        uuid: device.uuid,
        plan: subscription.plan,
        skipCapacityCheck: true,
      });
      addFailures = added.fail;
    }

    if (removed.fail > 0 || addFailures > 0) {
      throw new Error(
        `DEVICE_XRAY_SYNC_INCOMPLETE:remove=${removed.fail},add=${addFailures}`,
      );
    }

    if (subscription.plan === PlanType.STANDARD && active) {
      const failedNodeKeys: string[] = [];

      for (const node of this.getConfiguredH1Nodes()) {
        try {
          await this.provisionH1CloudDeviceNode(
            node.key,
            device,
            subscription.expiresAt,
          );
        } catch (error) {
          failedNodeKeys.push(node.key);
          this.logger.error(
            `Device H1Cloud sync failed for ${node.key} device ${device.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (failedNodeKeys.length > 0) {
        throw new Error(
          `DEVICE_H1CLOUD_SYNC_INCOMPLETE:${failedNodeKeys.join(',')}`,
        );
      }
    }

    await this.prisma.device.update({
      where: { id: device.id },
      data: { vpnSyncPending: false },
    });

    return device;
  }



  async removeSecondDeviceAccess(deviceId: string) {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
      include: {
        subscription: true,
        h1CloudClients: {
          select: {
            id: true,
            nodeKey: true,
            remoteName: true,
          },
        },
      },
    });

    if (device.slot !== 2) {
      throw new Error('PRIMARY_DEVICE_CANNOT_BE_REMOVED');
    }

    const removed = await this.xray.removeUserFromPlanNodes({
      uuid: device.uuid,
      plan: device.subscription.plan,
    });

    const failedNodeKeys: string[] = [];

    for (const client of device.h1CloudClients) {
      try {
        const nodeKey = client.nodeKey as H1CloudNodeKey;
        const existing = await this.h1cloud.getClientByName(
          client.remoteName,
          nodeKey,
        );

        if (existing) {
          await this.h1cloud.deleteClient(client.remoteName, nodeKey);
        }

        await this.prisma.h1CloudClient.deleteMany({
          where: { id: client.id },
        });
      } catch (error) {
        failedNodeKeys.push(client.nodeKey);
        this.logger.error(
          `H1Cloud remove failed for device ${device.id} node ${client.nodeKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (removed.fail > 0 || failedNodeKeys.length > 0) {
      throw new Error(
        `DEVICE_REMOVE_INCOMPLETE:xray=${removed.fail},h1=${failedNodeKeys.join(',')}`,
      );
    }

    return device;
  }

  async syncPendingSubscriptionStates(
    limit = 50,
  ) {
    const subscriptions =
      await this.prisma.subscription.findMany({
        where: {
          vpnSyncPending:
            true,
        },

        orderBy: {
          updatedAt:
            'asc',
        },

        take:
          limit,
      });

    let ok = 0;
    let fail = 0;

    for (
      const subscription of
      subscriptions
    ) {
      try {
        await this.syncSubscriptionState(
          subscription.id,
        );

        await this.prisma.subscription
          .updateMany({
            where: {
              id:
                subscription.id,

              vpnSyncPending:
                true,
            },

            data: {
              vpnSyncPending:
                false,
            },
          });

        ok++;
      } catch (error) {
        fail++;

        this.logger.warn(
          `Subscription state sync retry failed ${subscription.id}: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    }

    const pendingDevices = await this.prisma.device.findMany({
      where: {
        vpnSyncPending: true,
        isActive: true,
        subscription: {
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: new Date() },
          user: { isBlocked: false },
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: Math.max(0, limit - subscriptions.length),
      select: { id: true },
    });

    for (const device of pendingDevices) {
      try {
        await this.syncDeviceState(device.id);
        ok++;
      } catch (error) {
        fail++;

        this.logger.warn(
          `Device state sync retry failed ${device.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      total:
        subscriptions.length + pendingDevices.length,

      ok,
      fail,
    };
  }



  async syncReferralReward(
    rewardId: string,
  ) {
    const reward =
      await this.prisma.referralReward
        .findUnique({
          where: {
            id: rewardId,
          },
        });

    if (
      !reward ||
      !reward.appliedAt ||
      reward.legacyBackfilled
    ) {
      return {
        total: 0,
        ok: 0,
        fail: 0,
      };
    }

    let total = 0;
    let ok = 0;
    let fail = 0;

    if (
      reward.inviteeSyncPending &&
      reward.inviteeSubscriptionId
    ) {
      total++;

      try {
        await this.syncSubscriptionState(
          reward.inviteeSubscriptionId,
        );

        await this.prisma.referralReward
          .updateMany({
            where: {
              id:
                reward.id,

              inviteeSyncPending:
                true,
            },

            data: {
              inviteeSyncPending:
                false,
            },
          });

        ok++;
      } catch (error) {
        fail++;

        this.logger.warn(
          `Referral invitee sync failed ${reward.id}: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    }

    if (
      reward.referrerSyncPending &&
      reward.referrerSubscriptionId
    ) {
      total++;

      try {
        await this.syncSubscriptionState(
          reward.referrerSubscriptionId,
        );

        await this.prisma.referralReward
          .updateMany({
            where: {
              id:
                reward.id,

              referrerSyncPending:
                true,
            },

            data: {
              referrerSyncPending:
                false,
            },
          });

        ok++;
      } catch (error) {
        fail++;

        this.logger.warn(
          `Referral referrer sync failed ${reward.id}: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    }

    return {
      total,
      ok,
      fail,
    };
  }


  async syncPendingReferralRewards(
    limit = 50,
  ) {
    const rewards =
      await this.prisma.referralReward
        .findMany({
          where: {
            appliedAt: {
              not: null,
            },

            legacyBackfilled:
              false,

            OR: [
              {
                inviteeSyncPending:
                  true,
              },
              {
                referrerSyncPending:
                  true,
              },
            ],
          },

          orderBy: {
            updatedAt:
              'asc',
          },

          take:
            limit,
        });

    let ok = 0;
    let fail = 0;

    for (const reward of rewards) {
      const result =
        await this.syncReferralReward(
          reward.id,
        );

      ok += result.ok;
      fail += result.fail;
    }

    return {
      rewards:
        rewards.length,
      ok,
      fail,
    };
  }


  async processReferralBonus(
    inviteeId: string,
    referrerId: string,
  ) {
    let result:
      | {
          rewardId: string;
          processed: boolean;
          inviteeTrial: boolean;
          referrerBonus: boolean;
        }
      | undefined;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        result =
          await this.prisma.$transaction(
            async (tx) => {
              const now =
                new Date();

              const invitee =
                await tx.user.findUnique({
                  where: {
                    id:
                      inviteeId,
                  },

                  select: {
                    id:
                      true,

                    referredById:
                      true,

                    isBlocked:
                      true,
                  },
                });

              if (
                !invitee ||
                invitee.referredById !==
                  referrerId
              ) {
                throw new Error(
                  'REFERRAL_RELATION_INVALID',
                );
              }

              const referrer =
                await tx.user.findUnique({
                  where: {
                    id:
                      referrerId,
                  },

                  select: {
                    id:
                      true,

                    isBlocked:
                      true,
                  },
                });

              if (!referrer) {
                throw new Error(
                  'REFERRER_NOT_FOUND',
                );
              }

              let reward =
                await tx.referralReward
                  .findUnique({
                    where: {
                      inviteeId,
                    },
                  });

              /*
               * Уже применённый referral
               * повторно НИКОГДА не начисляем.
               */
              if (
                reward?.appliedAt
              ) {
                return {
                  rewardId:
                    reward.id,

                  processed:
                    false,

                  inviteeTrial:
                    reward.inviteeTrial ===
                    true,

                  referrerBonus:
                    false,
                };
              }

              if (
                reward &&
                reward.referrerId !==
                  referrerId
              ) {
                throw new Error(
                  'REFERRAL_REWARD_MISMATCH',
                );
              }

              if (!reward) {
                reward =
                  await tx.referralReward
                    .create({
                      data: {
                        inviteeId,
                        referrerId,
                      },
                    });
              }

              /*
               * Если invitee заблокирован,
               * фиксируем referral как обработанный,
               * но ничего никому не начисляем.
               */
              if (invitee.isBlocked) {
                await tx.referralReward
                  .update({
                    where: {
                      id:
                        reward.id,
                    },

                    data: {
                      inviteeTrial:
                        false,

                      referrerBonus:
                        false,

                      appliedAt:
                        now,

                      legacyBackfilled:
                        false,
                    },
                  });

                return {
                  rewardId:
                    reward.id,

                  processed:
                    true,

                  inviteeTrial:
                    false,

                  referrerBonus:
                    false,
                };
              }

              let inviteeTrial =
                false;

              let inviteeSubscriptionId:
                string | null =
                null;

              /*
               * Повторяем прежнюю бизнес-логику:
               * если у invitee уже есть активная
               * подписка любого тарифа —
               * отдельный trial не создаём.
               */
              const inviteeActive =
                await tx.subscription
                  .findFirst({
                    where: {
                      userId:
                        inviteeId,

                      status: {
                        in: [
                          SubscriptionStatus.ACTIVE,
                          SubscriptionStatus.TRIAL,
                        ],
                      },

                      expiresAt: {
                        gt:
                          now,
                      },
                    },

                    orderBy: {
                      expiresAt:
                        'desc',
                    },
                  });

              if (!inviteeActive) {
                const expiredInvitee =
                  await tx.subscription
                    .findFirst({
                      where: {
                        userId:
                          inviteeId,

                        plan:
                          PlanType.STANDARD,

                        status:
                          SubscriptionStatus.EXPIRED,
                      },

                      orderBy: {
                        createdAt:
                          'desc',
                      },
                    });

                const expiresAt =
                  new Date(now);

                expiresAt.setDate(
                  expiresAt.getDate() +
                    TRIAL_DAYS,
                );

                if (expiredInvitee) {
                  const restored =
                    await tx.subscription
                      .update({
                        where: {
                          id:
                            expiredInvitee.id,
                        },

                        data: {
                          startsAt:
                            now,

                          expiresAt,

                          status:
                            SubscriptionStatus.TRIAL,

                          isTrial:
                            true,
                        },
                      });

                  inviteeSubscriptionId =
                    restored.id;
                } else {
                  const created =
                    await tx.subscription
                      .create({
                        data: {
                          userId:
                            inviteeId,

                          plan:
                            PlanType.STANDARD,

                          status:
                            SubscriptionStatus.TRIAL,

                          uuid:
                            randomUUID(),

                          subToken:
                            randomBytes(24)
                              .toString(
                                'hex',
                              ),

                          startsAt:
                            now,

                          expiresAt,

                          isTrial:
                            true,
                        },
                      });

                  inviteeSubscriptionId =
                    created.id;
                }

                inviteeTrial =
                  true;
              }

              let referrerBonus =
                false;

              let referrerSubscriptionId:
                string | null =
                null;

              /*
               * Заблокированному referrer бонус
               * не начисляем.
               */
              if (!referrer.isBlocked) {
                const referrerActive =
                  await tx.subscription
                    .findFirst({
                      where: {
                        userId:
                          referrerId,

                        status: {
                          in: [
                            SubscriptionStatus.ACTIVE,
                            SubscriptionStatus.TRIAL,
                          ],
                        },

                        expiresAt: {
                          gt:
                            now,
                        },
                      },

                      orderBy: {
                        expiresAt:
                          'desc',
                      },
                    });

                if (referrerActive) {
                  if (
                    referrerActive.plan !==
                    PlanType.PREMIUM
                  ) {
                    const expiresAt =
                      new Date(
                        referrerActive.expiresAt,
                      );

                    expiresAt.setDate(
                      expiresAt.getDate() +
                        REFERRAL_BONUS_DAYS,
                    );

                    const updated =
                      await tx.subscription
                        .update({
                          where: {
                            id:
                              referrerActive.id,
                          },

                          data: {
                            expiresAt,

                            status:
                              SubscriptionStatus.ACTIVE,

                            /*
                             * Сохраняем старое
                             * поведение extendSubscription().
                             */
                            isTrial:
                              false,
                          },
                        });

                    referrerSubscriptionId =
                      updated.id;

                    referrerBonus =
                      true;
                  }
                } else {
                  const expiredReferrer =
                    await tx.subscription
                      .findFirst({
                        where: {
                          userId:
                            referrerId,

                          plan:
                            PlanType.STANDARD,

                          status:
                            SubscriptionStatus.EXPIRED,
                        },

                        orderBy: {
                          createdAt:
                            'desc',
                        },
                      });

                  const expiresAt =
                    new Date(now);

                  expiresAt.setDate(
                    expiresAt.getDate() +
                      REFERRAL_BONUS_DAYS,
                  );

                  if (expiredReferrer) {
                    const restored =
                      await tx.subscription
                        .update({
                          where: {
                            id:
                              expiredReferrer.id,
                          },

                          data: {
                            startsAt:
                              now,

                            expiresAt,

                            status:
                              SubscriptionStatus.TRIAL,

                            isTrial:
                              true,
                          },
                        });

                    referrerSubscriptionId =
                      restored.id;
                  } else {
                    const created =
                      await tx.subscription
                        .create({
                          data: {
                            userId:
                              referrerId,

                            plan:
                              PlanType.STANDARD,

                            status:
                              SubscriptionStatus.TRIAL,

                            uuid:
                              randomUUID(),

                            subToken:
                              randomBytes(24)
                                .toString(
                                  'hex',
                                ),

                            startsAt:
                              now,

                            expiresAt,

                            isTrial:
                              true,
                          },
                        });

                    referrerSubscriptionId =
                      created.id;
                  }

                  referrerBonus =
                    true;
                }
              }

              await tx.referralReward
                .update({
                  where: {
                    id:
                      reward.id,
                  },

                  data: {
                    inviteeTrial,

                    referrerBonus,

                    inviteeSubscriptionId,

                    referrerSubscriptionId,

                    inviteeSyncPending:
                      inviteeTrial &&
                      inviteeSubscriptionId !==
                        null,

                    referrerSyncPending:
                      referrerBonus &&
                      referrerSubscriptionId !==
                        null,

                    appliedAt:
                      now,

                    legacyBackfilled:
                      false,
                  },
                });

              return {
                rewardId:
                  reward.id,

                processed:
                  true,

                inviteeTrial,

                referrerBonus,
              };
            },
            {
              isolationLevel:
                Prisma
                  .TransactionIsolationLevel
                  .Serializable,
            },
          );

        break;
      } catch (error) {
        const retryable =
          error instanceof
            Prisma.PrismaClientKnownRequestError &&
          (
            error.code === 'P2034' ||
            error.code === 'P2002'
          );

        if (
          !retryable ||
          attempt === 3
        ) {
          throw error;
        }

        this.logger.warn(
          `Serializable referral conflict; retry ${attempt}/3`,
        );
      }
    }

    if (!result) {
      throw new Error(
        'REFERRAL_PROCESSING_FAILED',
      );
    }

    /*
     * DB entitlement уже атомарно сохранён.
     *
     * Ниже только идемпотентная внешняя
     * синхронизация по абсолютному состоянию БД.
     */
    await this.syncReferralReward(
      result.rewardId,
    );

    if (result.processed) {
      this.logger.log(
        `Referral processed: invitee=${inviteeId} referrer=${referrerId} inviteeTrial=${result.inviteeTrial} referrerBonus=${result.referrerBonus}`,
      );
    }

    return result;
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

    const devices = await this.prisma.device.findMany({
      where: { subscriptionId: sub.id },
      select: { id: true, uuid: true },
    });

    for (const device of devices) {
      try {
        const result = await this.xray.removeUserFromPlanNodes({
          uuid: device.uuid,
          plan: sub.plan,
        });

        if (result.fail > 0) {
          cleanupFailed = true;
        }
      } catch (error) {
        cleanupFailed = true;

        const message =
          error instanceof Error ? error.message : String(error);

        this.logger.error(
          `Xray remove failed for device ${device.id} subscription ${sub.id}: ${message}`,
        );
      }
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
    return this.prisma.device.count({
      where: {
        isActive: true,
        vpnSyncPending: false,
        subscription: {
          plan: PlanType.STANDARD,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: new Date() },
          user: { isBlocked: false },
        },
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

    const maintenance =
      this.getMaintenanceH1Nodes();

    return Promise.all(
      this.getConfiguredH1Nodes({
        includeMaintenance: true,
      }).map(
        async (node) => {
          if (maintenance.has(node.key)) {
            return {
              nodeKey: node.key,
              name: node.name,
              apiOk: false,
              latencyMs: 0,
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
              error: 'maintenance',
            };
          }

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
      const missing = await this.prisma.device.findMany({
        where: {
          isActive: true,
          vpnSyncPending: false,
          subscription: {
            plan: PlanType.STANDARD,
            status: {
              in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
            },
            expiresAt: { gt: new Date() },
            user: { isBlocked: false },
          },
          h1CloudClients: {
            none: {
              nodeKey: node.key,
            },
          },
        },
        include: {
          subscription: {
            select: { expiresAt: true },
          },
        },
      });

      total += missing.length;

      for (const device of missing) {
        try {
          await this.provisionH1CloudDeviceNode(
            node.key,
            device,
            device.subscription.expiresAt,
          );
          ok++;
        } catch (error) {
          fail++;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `H1Cloud recovery failed for ${node.key} device ${device.id}: ${message}`,
          );
        }
      }
    }

    return { total, ok, fail };
  }


  async reconcileH1CloudExpiries() {
    let total = 0;
    let synced = 0;
    let missing = 0;
    let ok = 0;
    let fail = 0;

    const devices = await this.prisma.device.findMany({
      where: {
        isActive: true,
        vpnSyncPending: false,
        subscription: {
          plan: PlanType.STANDARD,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: new Date() },
          user: { isBlocked: false },
        },
      },
      include: {
        subscription: {
          select: {
            expiresAt: true,
          },
        },
      },
    });

    for (const node of this.getConfiguredH1Nodes()) {
      let remoteClients: H1Client[];

      try {
        remoteClients = await this.h1cloud.getClients(node.key);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        this.logger.warn(
          `H1Cloud expiry reconcile skipped for ${node.key}: ${message}`,
        );

        continue;
      }

      const byName = new Map(
        remoteClients.map((client) => [client.name, client]),
      );

      for (const device of devices) {
        total++;

        const remoteName =
          device.slot === 1
            ? this.h1cloud.nameForSubscription(device.subscriptionId)
            : this.h1cloud.nameForDevice(device.id);
        const remote = byName.get(remoteName);

        if (!remote) {
          missing++;
          continue;
        }

        const localExpires = Math.floor(
          device.subscription.expiresAt.getTime() / 1000,
        );
        const remoteExpires = Number(remote.expires_at || 0);
        const driftSeconds = localExpires - remoteExpires;

        if (driftSeconds <= 3600) {
          ok++;
          continue;
        }

        const days = Math.max(1, Math.ceil(driftSeconds / 86400));

        try {
          const client =
            device.slot === 1
              ? await this.h1cloud.extendForSubscription(
                  device.subscriptionId,
                  days,
                  node.key,
                  this.getRemainingDays(device.subscription.expiresAt),
                )
              : await this.h1cloud.extendForDevice(
                  device.id,
                  days,
                  node.key,
                  this.getRemainingDays(device.subscription.expiresAt),
                );

          await this.saveH1CloudClient(
            node.key,
            device.subscriptionId,
            device.id,
            client,
          );

          synced++;

          this.logger.log(
            `H1Cloud expiry reconciled for ${node.key} device ${device.id}: +${days} day(s)`,
          );
        } catch (error) {
          fail++;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `H1Cloud expiry reconcile failed for ${node.key} device ${device.id}: ${message}`,
          );
        }
      }
    }

    return {
      total,
      ok,
      synced,
      missing,
      fail,
    };
  }

  async buildSubscriptionLinks(sub: {
    id?: string;
    deviceId?: string;
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
        : node.name.toLowerCase().includes("london")
          ? "🇬🇧"
        : node.name.toLowerCase().includes("netherlands")
          ? "🇳🇱"
          : node.name.toLowerCase().includes("france")
            ? "🇫🇷"
            : node.name.toLowerCase().includes("finland")
              ? "🇫🇮"
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

      if (node.name.toLowerCase().includes("london")) {
        const mainName = encodeURIComponent("🇬🇧 London MAIN");
        const xhttpName = encodeURIComponent("🇬🇧 London XHTTP");
        const wsName = encodeURIComponent("🇬🇧 London WS");
        const fastName = encodeURIComponent("🇬🇧 London FAST");

        const main =
          `vless://${sub.uuid}@${node.host}:443` +
          `?encryption=none` +
          `&flow=xtls-rprx-vision` +
          `&security=reality` +
          `&sni=${node.sni}` +
          `&fp=${node.fingerprint}` +
          `&pbk=${node.publicKey}` +
          `&sid=${node.shortId}` +
          `&type=tcp` +
          `&headerType=none` +
          `#${mainName}`;

        const xhttp =
          `vless://${sub.uuid}@${node.host}:445` +
          `?encryption=none` +
          `&security=reality` +
          `&sni=${node.sni}` +
          `&fp=${node.fingerprint}` +
          `&pbk=${node.publicKey}` +
          `&sid=${node.shortId}` +
          `&type=xhttp` +
          `&path=${encodeURIComponent("/4steps-xhttp")}` +
          `#${xhttpName}`;

        const ws =
          `vless://${sub.uuid}@${node.host}:444` +
          `?encryption=none` +
          `&security=none` +
          `&type=ws` +
          `&host=ws-uk1.4stepsvpn.ru` +
          `&path=${encodeURIComponent("/ws-test")}` +
          `#${wsName}`;

        const fast =
          `hy2://${sub.uuid}@hy-uk1.4stepsvpn.ru:443/` +
          `?sni=hy-uk1.4stepsvpn.ru` +
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
          ...(sub.deviceId ? { deviceId: sub.deviceId } : {}),
        },
        select: {
          nodeKey: true,
          remoteName: true,
          remoteUuid: true,
          remoteLink: true,
        },
      });

      const linksByNode = new Map(
        h1Links.map((item) => [item.nodeKey, item]),
      );

      const inboundMap: Record<
        string,
        {
          main: string;
          ws: string;
          xhttp: string;
          label: string;
        }
      > = {
        FI1: {
          main: "ib_b283f216e2",
          ws: "ib_9ce64d61e4",
          xhttp: "ib_cc89fe9508",
          label: "Finland",
        },
        ES1: {
          main: "ib_5b91a687cd",
          ws: "ib_408fbb730c",
          xhttp: "ib_f1b9465174",
          label: "Spain",
        },
        CH1: {
          main: "ib_0f67f5820b",
          ws: "ib_16f6636dbf",
          xhttp: "ib_d0aac15723",
          label: "Switzerland",
        },
      };

      const h1LinkGroups = await Promise.all(
        this.getConfiguredH1Nodes().map(async (node) => {
          const h1Client =
            linksByNode.get(node.key);

          if (!h1Client?.remoteLink) {
            return [];
          }

          const name =
            encodeURIComponent(node.name);

          const inboundConfig =
            inboundMap[node.key];

          if (
            node.key === "NL1" &&
            h1Client.remoteUuid
          ) {
            try {
              let remoteClient = null;

              for (let attempt = 1; attempt <= 2; attempt++) {
                remoteClient =
                  await this.h1cloud.getClientByName(
                    h1Client.remoteName,
                    node.key,
                    10000,
                  );

                const customWs =
                  remoteClient?.inbound_links?.find(
                    (inbound) =>
                      inbound.id === "ib_bd6bce0091" ||
                      inbound.tag === "nl1-netherlands-ws",
                  );

                const customXhttp =
                  remoteClient?.inbound_links?.find(
                    (inbound) =>
                      inbound.id === "ib_4e1b19c314" ||
                      inbound.tag === "nl1-netherlands-xhttp",
                  );

                if (
                  remoteClient?.links?.reality &&
                  customWs?.link &&
                  customXhttp?.link
                ) {
                  break;
                }

                if (attempt < 2) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, 250),
                  );
                }
              }

              if (!remoteClient) {
                throw new Error(
                  "remote client not found",
                );
              }

              const customWs =
                remoteClient.inbound_links?.find(
                  (inbound) =>
                    inbound.id === "ib_bd6bce0091" ||
                    inbound.tag === "nl1-netherlands-ws",
                );

              const customXhttp =
                remoteClient.inbound_links?.find(
                  (inbound) =>
                    inbound.id === "ib_4e1b19c314" ||
                    inbound.tag === "nl1-netherlands-xhttp",
                );

              if (
                !remoteClient.links?.reality ||
                !customWs?.link ||
                !customXhttp?.link
              ) {
                throw new Error(
                  "NL1 required links missing after retry",
                );
              }

              const nodeLinks: string[] = [];

              const appendLink = (
                link: string | undefined,
                suffix: string,
              ) => {
                if (!link) {
                  return;
                }

                const linkName =
                  encodeURIComponent(
                    `${node.name} ${suffix}`,
                  );

                const base =
                  link.split("#")[0];

                nodeLinks.push(
                  `${base}#${linkName}`,
                );
              };

              appendLink(
                remoteClient.links?.reality,
                "MAIN",
              );

              appendLink(
                customWs.link,
                "WS",
              );

              appendLink(
                customXhttp.link,
                "XHTTP",
              );

              if (nodeLinks.length) {
                return nodeLinks;
              }

              throw new Error(
                "NL1 built-in links missing",
              );
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error);

              this.logger.warn(
                `Netherlands H1Cloud links unavailable for subscription ${sub.id}: ${message}`,
              );

              if (h1Client.remoteLink) {
                const mainBase =
                  h1Client.remoteLink.split("#")[0];

                const mainName =
                  encodeURIComponent(
                    `${node.name} MAIN`,
                  );

                return [
                  `${mainBase}#${mainName}`,
                ];
              }

              return [];
            }
          }

          if (
            inboundConfig &&
            h1Client.remoteUuid
          ) {
            try {
              const remoteClient =
                await this.h1cloud.getClientByName(
                  h1Client.remoteName,
                  node.key,
                  2000,
                );

              if (!remoteClient) {
                throw new Error(
                  "remote client not found",
                );
              }

              const nodeLinks: string[] = [];

              const appendInboundLink = (
                inboundId: string,
                suffix: string,
              ) => {
                const inboundLink =
                  remoteClient.inbound_links?.find(
                    (inbound) =>
                      inbound.id === inboundId,
                  )?.link;

                if (!inboundLink) {
                  this.logger.warn(
                    `${inboundConfig.label} ${suffix} link missing for subscription ${sub.id}`,
                  );
                  return;
                }

                const linkName =
                  encodeURIComponent(
                    `${node.name} ${suffix}`,
                  );

                const base =
                  inboundLink.split("#")[0];

                nodeLinks.push(
                  `${base}#${linkName}`,
                );
              };

              appendInboundLink(
                inboundConfig.main,
                "MAIN",
              );

              appendInboundLink(
                inboundConfig.xhttp,
                "LTE",
              );

              appendInboundLink(
                inboundConfig.ws,
                "WS",
              );

              return nodeLinks;
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error);

              this.logger.warn(
                `${inboundConfig.label} H1Cloud links unavailable for subscription ${sub.id}: ${message}`,
              );

              /*
               * H1Cloud fallback:
               *
               * Если API конкретной H1Cloud-ноды временно
               * недоступен, не удаляем страну из подписки.
               *
               * MAIN берём из сохранённого remoteLink.
               * LTE/XHTTP и WS собираем локально
               * из сохранённого UUID и конфигурации ноды.
               * Пользователь сохраняет все три профиля
               * даже при недоступном management API.
               */
              const fallbackWs: Record<
                string,
                {
                  host: string;
                  wsHost: string;
                  wsPort: number;
                  xhttpHost: string;
                  xhttpPort: number;
                }
              > = {
                FI1: {
                  host: "fi3.h1cloud.net",
                  wsHost: "ws-fi1.4stepsvpn.ru",
                  wsPort: 25827,
                  xhttpHost: "xhttp-fi1.4stepsvpn.ru",
                  xhttpPort: 25829,
                },
                ES1: {
                  host: "es1.h1cloud.net",
                  wsHost: "ws-es1.4stepsvpn.ru",
                  wsPort: 25488,
                  xhttpHost: "xhttp-es1.4stepsvpn.ru",
                  xhttpPort: 25489,
                },
                CH1: {
                  host: "ch1.h1cloud.net",
                  wsHost: "ws-ch1.4stepsvpn.ru",
                  wsPort: 25054,
                  xhttpHost: "xhttp-ch1.4stepsvpn.ru",
                  xhttpPort: 25059,
                },
              };

              const fallback =
                fallbackWs[node.key];

              if (
                fallback &&
                h1Client.remoteUuid &&
                h1Client.remoteLink
              ) {
                const fallbackLinks: string[] = [];

                /*
                 * MAIN:
                 * используем уже сохранённую рабочую ссылку,
                 * поэтому не дублируем Reality-параметры
                 * в исходном коде.
                 */
                const mainBase =
                  h1Client.remoteLink.split("#")[0];

                const mainName =
                  encodeURIComponent(
                    `${node.name} MAIN`,
                  );

                fallbackLinks.push(
                  `${mainBase}#${mainName}`,
                );

                /*
                 * LTE / XHTTP:
                 * сохраняем профиль даже при недоступном
                 * management API H1Cloud.
                 */
                const lteName =
                  encodeURIComponent(
                    `${node.name} LTE`,
                  );

                fallbackLinks.push(
                  `vless://${h1Client.remoteUuid}@${fallback.host}:${fallback.xhttpPort}` +
                    `?type=xhttp` +
                    `&security=none` +
                    `&path=${encodeURIComponent("/api/v1/sync/")}` +
                    `&host=${fallback.xhttpHost}` +
                    `&mode=auto` +
                    `&encryption=none` +
                    `#${lteName}`,
                );

                /*
                 * WS:
                 * одинаковая схема на наших H1Cloud-нодах.
                 */
                const wsName =
                  encodeURIComponent(
                    `${node.name} WS`,
                  );

                fallbackLinks.push(
                  `vless://${h1Client.remoteUuid}@${fallback.host}:${fallback.wsPort}` +
                    `?encryption=none` +
                    `&security=none` +
                    `&type=ws` +
                    `&host=${fallback.wsHost}` +
                    `&path=${encodeURIComponent("/ws-test")}` +
                    `#${wsName}`,
                );

                this.logger.warn(
                  `${inboundConfig.label} subscription fallback active: MAIN + LTE + WS`,
                );

                return fallbackLinks;
              }

              return [];
            }
          }

          const base =
            h1Client.remoteLink.split("#")[0];

          return [
            `${base}#${name}`,
          ];
        }),
      );

      links.push(
        ...h1LinkGroups.flat(),
      );
    }

    return links;
  }
}
