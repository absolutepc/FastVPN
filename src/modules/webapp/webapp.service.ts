import { Injectable, UnauthorizedException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PaymentsService } from '../payments/payments.service';
import { PlanType, SubscriptionStatus } from '@prisma/client';
import { XrayService } from '../xray/xray.service';

@Injectable()
export class WebappService {
  private readonly logger = new Logger(WebappService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly payments: PaymentsService,
    private readonly xray: XrayService,
  ) {}

  /** Validate Telegram WebApp initData (HMAC-SHA256) */
  validateInitData(initData: string): { id: number; username?: string; first_name?: string; last_name?: string } {
    if (!initData) throw new UnauthorizedException('No initData');

    const botToken = this.config.getOrThrow<string>('BOT_TOKEN');
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) throw new UnauthorizedException('No hash');

    params.delete('hash');
    const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculated !== hash) {
      this.logger.warn('Invalid initData hash');
      throw new UnauthorizedException('Invalid initData');
    }

    const authDate = Number(params.get('auth_date') || 0);
    if (authDate && Date.now() / 1000 - authDate > 86400) throw new UnauthorizedException('initData expired');

    const userRaw = params.get('user');
    if (!userRaw) throw new UnauthorizedException('No user in initData');
    return JSON.parse(userRaw);
  }

  private isAdminTelegramId(telegramId: number): boolean {
    const adminIds = (this.config.get<string>('ADMIN_IDS') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    return adminIds.includes(String(telegramId));
  }

  private requireAdmin(initData: string) {
    const tg = this.validateInitData(initData);

    if (!this.isAdminTelegramId(tg.id)) {
      this.logger.warn(`WebApp admin access denied: telegram=${tg.id}`);
      throw new ForbiddenException('Admin access required');
    }

    return tg;
  }

  async findOrCreateFromTelegram(tg: { id: number; username?: string; first_name?: string; last_name?: string }) {
    const telegramId = BigInt(tg.id);
    let user = await this.prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          telegramId,
          username: tg.username ?? null,
          firstName: tg.first_name ?? null,
          lastName: tg.last_name ?? null,
          referralCode: randomBytes(4).toString('hex'),
        },
      });
      this.logger.log(`WebApp new user: ${tg.id}`);
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          username: tg.username ?? user.username,
          firstName: tg.first_name ?? user.firstName,
          lastName: tg.last_name ?? user.lastName,
        },
      });
    }

    if (user.isBlocked) throw new ForbiddenException('User blocked');
    return user;
  }

  async getCabinet(initData: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);
    const sub = await this.subscriptions.getActiveSubscription(user.id);
    const latestSub = sub ? sub : await this.subscriptions.getLatestSubscription(user.id);
    const device = sub ? await this.prisma.device.findUnique({ where: { subscriptionId: sub.id } }) : null;

    const subscriptionState = sub ? 'ACTIVE' : latestSub ? 'EXPIRED' : 'NONE';
    const daysLeft = sub
      ? Math.max(0, Math.ceil((sub.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 0;

    const appUrl = (this.config.get<string>('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');
    const botUsername = this.config.get<string>('BOT_USERNAME') || 'FourStepsVPNbot';

    return {
      user: { id: user.id, firstName: user.firstName, username: user.username, referralCode: user.referralCode },
      isAdmin: this.isAdminTelegramId(tg.id),
      subscriptionState,
      daysLeft,
      deviceLimit: 1,
      deviceUsed: device?.isActive ? 1 : 0,
      device: device
        ? {
            id: device.id,
            name: device.name,
            platform: device.platform,
            isActive: device.isActive,
            createdAt: device.createdAt.toISOString(),
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          }
        : null,
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            isTrial: sub.isTrial,
            expiresAt: sub.expiresAt.toISOString(),
            subUrl: `${appUrl}/sub/${sub.subToken}.txt`,
          }
        : null,
      referralLink: `https://t.me/${botUsername}?start=${user.referralCode}`,
      plans: [
        { id: 'STANDARD', name: 'Стандарт', price: 300, description: 'Обычные серверы' },
        { id: 'PREMIUM', name: 'Премиум', price: 600, description: 'Выделенные серверы, макс. 50 человек' },
      ],
    };
  }


  async getAdminDashboard(initData: string) {
    const admin = this.requireAdmin(initData);
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const [
      users,
      activeSubscriptions,
      trials,
      revenue,
      expiringToday,
      nodes,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.subscription.count({
        where: {
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gt: now },
          user: { isBlocked: false },
        },
      }),
      this.prisma.subscription.count({
        where: {
          status: SubscriptionStatus.TRIAL,
          expiresAt: { gt: now },
          user: { isBlocked: false },
        },
      }),
      this.prisma.payment.aggregate({
        where: { status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),
      this.prisma.subscription.count({
        where: {
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
          },
          expiresAt: { gte: startOfDay, lte: endOfDay },
          user: { isBlocked: false },
        },
      }),
      this.prisma.node.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const nodeStatuses = await Promise.all(
      nodes.map(async (node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        host: node.host,
        port: node.port,
        maxUsers: node.maxUsers,
        users: await this.xray.countUsersOnNodeType(node.type),
        apiOnline: await this.xray.pingNode(node),
      })),
    );

    let h1Cloud: {
      apiOk: boolean;
      clients: number;
      online: number;
      expected: number;
    };

    try {
      h1Cloud = await this.subscriptions.getH1CloudMonitoringStatus();
    } catch (error) {
      this.logger.warn(
        `WebApp Finland monitoring unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      h1Cloud = {
        apiOk: false,
        clients: 0,
        online: 0,
        expected: 0,
      };
    }

    return {
      admin: {
        telegramId: admin.id,
        username: admin.username || null,
      },
      stats: {
        users,
        activeSubscriptions,
        trials,
        revenueRub: Math.round((revenue._sum.amount || 0) / 100),
        expiringToday,
        servers: nodeStatuses.length + 1,
      },
      nodes: nodeStatuses,
      h1Cloud,
      generatedAt: new Date().toISOString(),
    };
  }

  async activateDevice(initData: string, name?: string, platform?: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);
    const sub = await this.subscriptions.getActiveSubscription(user.id);
    if (!sub) throw new BadRequestException('Active subscription required');

    const existing = await this.prisma.device.findUnique({ where: { subscriptionId: sub.id } });
    if (existing) {
      return {
        device: existing,
        created: false,
        message: 'Device already activated for this subscription',
      };
    }

    const device = await this.prisma.device.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        uuid: randomUUID(),
        name: (name || 'Моё устройство').trim().slice(0, 80),
        platform: platform?.trim().slice(0, 40) || null,
        isActive: true,
      },
    });

    this.logger.log(`Device activated: user=${user.id} subscription=${sub.id} device=${device.id}`);
    return { device, created: true };
  }

  async createPayment(initData: string, planKey: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);
    const plan = planKey === 'PREMIUM' || planKey === 'premium' ? PlanType.PREMIUM : PlanType.STANDARD;
    const result = await this.payments.createPayment({ userId: user.id, plan });
    return { confirmationUrl: result.confirmationUrl, amount: result.amount, plan };
  }
}
