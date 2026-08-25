import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Node, NodeType, PlanType } from '@prisma/client';

type VlessFlow = '' | 'xtls-rprx-vision';

@Injectable()
export class XrayService {
  private readonly logger = new Logger(XrayService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async getClient(node: Node) {
    const host = node.apiHost || node.host;
    const port = node.apiPort || 10085;

    try {
      const { XtlsApi } = await import('@remnawave/xtls-sdk');
      return new XtlsApi(host, String(port));
    } catch (e) {
      this.logger.warn(
        `xtls-sdk not available or failed for ${node.name} (${host}:${port})`,
        e instanceof Error ? e.message : e,
      );
      return null;
    }
  }

  private emailFor(uuid: string) {
    return `${uuid}@4stepsvpn.local`;
  }

  async getNodesForPlan(plan: PlanType): Promise<Node[]> {
    const type = plan === PlanType.PREMIUM ? NodeType.PREMIUM : NodeType.STANDARD;
    return this.prisma.node.findMany({
      where: { isActive: true, type },
    });
  }

  async countUsersOnNodeType(type: NodeType): Promise<number> {
    const plan = type === NodeType.PREMIUM ? PlanType.PREMIUM : PlanType.STANDARD;
    const now = new Date();
    return this.prisma.subscription.count({
      where: {
        plan,
        status: { in: ['ACTIVE', 'TRIAL'] },
        expiresAt: { gt: now },
        user: { isBlocked: false },
      },
    });
  }

  async canAcceptPremium(): Promise<boolean> {
    const nodes = await this.prisma.node.findMany({
      where: { isActive: true, type: NodeType.PREMIUM },
    });

    if (nodes.length === 0) return false;

    const capacity = nodes.reduce((sum, n) => sum + (n.maxUsers ?? 50), 0);
    const current = await this.countUsersOnNodeType(NodeType.PREMIUM);

    return current < capacity;
  }

  async addUserToPlanNodes(params: {
    uuid: string;
    plan: PlanType;
    flow?: VlessFlow;
    skipCapacityCheck?: boolean;
  }): Promise<{ ok: number; fail: number }> {
    if (
      params.plan === PlanType.PREMIUM &&
      params.skipCapacityCheck !== true
    ) {
      const allowed = await this.canAcceptPremium();
      if (!allowed) {
        this.logger.warn('Premium capacity full — skip addUser');
        return { ok: 0, fail: 0 };
      }
    }

    const nodes = await this.getNodesForPlan(params.plan);
    let ok = 0;
    let fail = 0;
    const flow: VlessFlow = params.flow ?? 'xtls-rprx-vision';

    for (const node of nodes) {
      const success = await this.addUserToNode(node, params.uuid, flow);
      if (success) ok++;
      else fail++;
    }

    this.logger.log(`addUser ${params.uuid} plan=${params.plan}: ok=${ok} fail=${fail}`);
    return { ok, fail };
  }

  async addUserToNode(
    node: Node,
    uuid: string,
    flow: VlessFlow = 'xtls-rprx-vision',
  ): Promise<boolean> {
    const api = await this.getClient(node);
    if (!api) return false;

    const inbounds: Array<{ tag: string; flow: VlessFlow }> =
      (
        node.name.toLowerCase().includes('germany') ||
        node.name.toLowerCase().includes('london')
      )
        ? [
            {
              tag: node.inboundTag || 'vless-reality',
              flow: 'xtls-rprx-vision',
            },
            {
              tag: 'vless-ws',
              flow: '',
            },
            {
              tag: 'vless-xhttp',
              flow: '',
            },
          ]
        : [
            {
              tag: node.inboundTag || 'vless-reality',
              flow,
            },
          ];

    let success = true;

    for (const inbound of inbounds) {
      try {
        const result = await api.handler.addVlessUser({
          tag: inbound.tag,
          username: this.emailFor(uuid),
          uuid,
          flow: inbound.flow,
          level: 0,
        });

        if (result && (result as { isOk?: boolean }).isOk === false) {
          this.logger.warn(
            `addVlessUser failed on ${node.name} inbound=${inbound.tag}`,
            result,
          );
          success = false;
        }
      } catch (e) {
        this.logger.error(
          `addUserToNode ${node.name} inbound=${inbound.tag}`,
          e instanceof Error ? e.message : e,
        );
        success = false;
      }
    }

    return success;
  }

  async removeUserFromPlanNodes(params: {
    uuid: string;
    plan?: PlanType;
  }): Promise<{ ok: number; fail: number }> {
    const nodes = params.plan
      ? await this.getNodesForPlan(params.plan)
      : await this.prisma.node.findMany({ where: { isActive: true } });

    let ok = 0;
    let fail = 0;

    for (const node of nodes) {
      const success = await this.removeUserFromNode(node, params.uuid);
      if (success) ok++;
      else fail++;
    }

    this.logger.log(`removeUser ${params.uuid}: ok=${ok} fail=${fail}`);
    return { ok, fail };
  }

  async removeUserFromNode(node: Node, uuid: string): Promise<boolean> {
    const api = await this.getClient(node);
    if (!api) return false;

    const inboundTags =
      node.name.toLowerCase().includes('germany') ||
      node.name.toLowerCase().includes('london')
        ? [node.inboundTag || 'vless-reality', 'vless-ws', 'vless-xhttp']
      : [node.inboundTag || 'vless-reality'];

    let success = true;

    for (const tag of inboundTags) {
      try {
        const result = await api.handler.removeUser(
          tag,
          this.emailFor(uuid),
        );

        if (result && (result as { isOk?: boolean }).isOk === false) {
          this.logger.debug(
            `removeUser soft-fail on ${node.name} inbound=${tag}`,
            result,
          );

          success = false;
        }
      } catch (e) {
        this.logger.error(
          `removeUserFromNode ${node.name} inbound=${tag}`,
          e instanceof Error ? e.message : e,
        );
        success = false;
      }
    }

    return success;
  }

  async syncActiveUsersToNode(
  node: Node,
): Promise<{ total: number; ok: number; fail: number }> {
  const plan =
    node.type === NodeType.PREMIUM
      ? PlanType.PREMIUM
      : PlanType.STANDARD;

  const now = new Date();

  const subscriptions =
    await this.prisma.subscription.findMany({
      where: {
        plan,
        status: {
          in: ['ACTIVE', 'TRIAL'],
        },
        expiresAt: {
          gt: now,
        },
        user: {
          isBlocked: false,
        },
      },
      select: {
        uuid: true,
      },
    });

  let ok = 0;
  let fail = 0;

  for (const sub of subscriptions) {
    // Делаем синхронизацию идемпотентной:
    // если пользователь уже был добавлен при прошлой попытке,
    // сначала удаляем его и создаём заново.
    await this.removeUserFromNode(
      node,
      sub.uuid,
    ).catch(() => false);

    const added = await this.addUserToNode(
      node,
      sub.uuid,
      'xtls-rprx-vision',
    );

    if (added) {
      ok++;
    } else {
      fail++;
    }
  }

  this.logger.log(
    `syncActiveUsersToNode ${node.name}: total=${subscriptions.length} ok=${ok} fail=${fail}`,
  );

  return {
    total: subscriptions.length,
    ok,
    fail,
  };
}

  async getUsersCountOnNode(node: Node): Promise<number | null> {
  const api = await this.getClient(node);
  if (!api) return null;

  try {
    const result = await api.handler.getInboundUsersCount(
      node.inboundTag || 'vless-reality',
    );

    if (!result || (result as { isOk?: boolean }).isOk === false) {
      return null;
    }

    const data = (result as { data?: unknown }).data;

    return typeof data === 'number'
      ? data
      : null;
  } catch (e) {
    this.logger.warn(
      `getUsersCountOnNode failed for ${node.name}`,
      e instanceof Error ? e.message : e,
    );

    return null;
  }
}

  async pingNode(node: Node): Promise<boolean> {
    const api = await this.getClient(node);
    if (!api) return false;

    try {
      await api.handler.getInboundUsersCount(node.inboundTag || 'vless-reality');
      return true;
    } catch {
      return false;
    }
  }
}
