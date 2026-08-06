import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Node, NodeType, PlanType } from '@prisma/client';

/**
 * Управление пользователями на Xray-нодах через gRPC API.
 *
 * Требования к ноде:
 * - Xray-core с API inbound (dokodemo-door) на apiPort (по умолчанию 10085)
 * - HandlerService / StatsService включены
 * - inbound с tag = node.inboundTag (по умолчанию "vless-reality")
 *
 * Используется @remnawave/xtls-sdk.
 * Если SDK недоступен или нода не отвечает — логируем ошибку, не падаем.
 */
@Injectable()
export class XrayService {
  private readonly logger = new Logger(XrayService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async getClient(node: Node) {
    const host = node.apiHost || node.host;
    const port = node.apiPort || 10085;

    try {
      // Динамический import — чтобы проект собирался даже без установленного SDK локально
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

  /** Email в Xray = стабильный идентификатор для логов/статы */
  private emailFor(uuid: string) {
    return `${uuid}@access.one`;
  }

  /** Активные ноды нужного типа */
  async getNodesForPlan(plan: PlanType): Promise<Node[]> {
    const type = plan === PlanType.PREMIUM ? NodeType.PREMIUM : NodeType.STANDARD;
    return this.prisma.node.findMany({
      where: { isActive: true, type },
    });
  }

  /**
   * Сколько «живых» пользователей сейчас на ноде (по активным подпискам этого типа).
   * Для Premium — жёсткий лимит maxUsers (50).
   */
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

  /** Можно ли принять ещё одного Premium-пользователя */
  async canAcceptPremium(): Promise<boolean> {
    const nodes = await this.prisma.node.findMany({
      where: { isActive: true, type: NodeType.PREMIUM },
    });

    if (nodes.length === 0) return false;

    // Считаем пользователей на весь пул premium-нод
    // Лимит = sum(maxUsers) или 50 * количество нод
    const capacity = nodes.reduce((sum, n) => sum + (n.maxUsers ?? 50), 0);
    const current = await this.countUsersOnNodeType(NodeType.PREMIUM);

    return current < capacity;
  }

  /** Добавить пользователя на все ноды тарифа */
  async addUserToPlanNodes(params: {
    uuid: string;
    plan: PlanType;
    flow?: string;
  }): Promise<{ ok: number; fail: number }> {
    if (params.plan === PlanType.PREMIUM) {
      const allowed = await this.canAcceptPremium();
      if (!allowed) {
        this.logger.warn('Premium capacity full — skip addUser');
        return { ok: 0, fail: 0 };
      }
    }

    const nodes = await this.getNodesForPlan(params.plan);
    let ok = 0;
    let fail = 0;

    for (const node of nodes) {
      const success = await this.addUserToNode(node, params.uuid, params.flow ?? 'xtls-rprx-vision');
      if (success) ok++;
      else fail++;
    }

    this.logger.log(`addUser ${params.uuid} plan=${params.plan}: ok=${ok} fail=${fail}`);
    return { ok, fail };
  }

  async addUserToNode(node: Node, uuid: string, flow = 'xtls-rprx-vision'): Promise<boolean> {
    const api = await this.getClient(node);
    if (!api) return false;

    try {
      const result = await api.handler.addVlessUser({
        tag: node.inboundTag || 'vless-reality',
        username: this.emailFor(uuid),
        uuid,
        flow,
        level: 0,
      });

      if (result && (result as { isOk?: boolean }).isOk === false) {
        this.logger.warn(`addVlessUser failed on ${node.name}`, result);
        return false;
      }

      return true;
    } catch (e) {
      this.logger.error(`addUserToNode ${node.name}`, e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** Удалить пользователя со всех нод тарифа (или со всех нод) */
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

    try {
      const result = await api.handler.removeUser(
        node.inboundTag || 'vless-reality',
        this.emailFor(uuid),
      );

      if (result && (result as { isOk?: boolean }).isOk === false) {
        // уже удалён — не считаем критичной ошибкой
        this.logger.debug(`removeUser soft-fail on ${node.name}`, result);
      }

      return true;
    } catch (e) {
      this.logger.error(`removeUserFromNode ${node.name}`, e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** Проверка доступности API ноды */
  async pingNode(node: Node): Promise<boolean> {
    const api = await this.getClient(node);
    if (!api) return false;

    try {
      // list users as healthcheck
      await api.handler.getInboundUsersCount(node.inboundTag || 'vless-reality');
      return true;
    } catch {
      return false;
    }
  }
}
