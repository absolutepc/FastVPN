import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PaymentsService } from '../payments/payments.service';
import { PaymentStatus, PlanType, SubscriptionStatus } from '@prisma/client';
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


  private getNodeMetrics(host: string): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/ssh',
        [
          '-i',
          '/root/.ssh/4stepsvpn_xray',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          '-o',
          'StrictHostKeyChecking=yes',
          `root@${host}`,
          '4steps-node-metrics',
        ],
        {
          timeout: 8000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            return resolve(null);
          }

          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        },
      );
    });
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
      nodes.map(async (node) => {
        const [users, apiOnline, metrics] = await Promise.all([
          this.xray.countUsersOnNodeType(node.type),
          this.xray.pingNode(node),
          this.getNodeMetrics(node.host),
        ]);

        return {
          id: node.id,
          name: node.name,
          type: node.type,
          host: node.host,
          port: node.port,
          maxUsers: node.maxUsers,
          users,
          apiOnline,
          metrics,
        };
      }),
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


  async createManualWebappPayment(
    initData: string,
    planKey: string,
    bankKey: string,
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    const plan =
      planKey.toUpperCase() === 'STANDARD'
        ? PlanType.STANDARD
        : null;

    if (!plan) {
      throw new BadRequestException('Сейчас доступен только тариф Стандарт');
    }

    const bank = bankKey.toUpperCase();

    if (bank !== 'TBANK' && bank !== 'SBER') {
      throw new BadRequestException('Выберите банк');
    }

    const submitted = await this.prisma.payment.findFirst({
      where: {
        userId: user.id,
        status: PaymentStatus.PENDING,
        paymentMethod: 'MANUAL_SBP',
        proofFileId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (submitted) {
      throw new BadRequestException(
        'У вас уже есть платёж на проверке',
      );
    }

    await this.prisma.payment.updateMany({
      where: {
        userId: user.id,
        status: PaymentStatus.PENDING,
        paymentMethod: 'MANUAL_SBP',
        proofFileId: null,
      },
      data: {
        status: PaymentStatus.CANCELLED,
      },
    });

    const payment = await this.payments.createManualPayment({
      userId: user.id,
      plan,
      bank: bank as 'TBANK' | 'SBER',
    });

    const phone =
      this.config.get<string>('PAYMENT_PHONE') || '+79626542959';

    const recipient =
      this.config.get<string>('PAYMENT_RECIPIENT') || 'Тамерлан Д.';

    return {
      paymentId: payment.id,
      plan: payment.plan,
      amountRub: Math.round(payment.amount / 100),
      days: 30,
      bank,
      bankName: bank === 'TBANK' ? 'Т-Банк' : 'Сбербанк',
      phone,
      recipient,
      status: payment.status,
    };
  }

  async submitManualWebappProof(
    initData: string,
    paymentId: string,
    file?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    if (!file?.buffer?.length) {
      throw new BadRequestException('Выберите файл чека');
    }

    const allowedTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);

    if (!allowedTypes.has(file.mimetype)) {
      throw new BadRequestException(
        'Разрешены JPEG, PNG, WebP и PDF',
      );
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('Размер файла не должен превышать 10 МБ');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: true },
    });

    if (
      !payment ||
      payment.userId !== user.id ||
      payment.paymentMethod !== 'MANUAL_SBP'
    ) {
      throw new ForbiddenException('Платёж недоступен');
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException('Платёж уже обработан');
    }

    if (payment.proofFileId) {
      throw new BadRequestException('Чек уже отправлен на проверку');
    }

    const reservation = `UPLOADING:${randomUUID()}`;

    const reserved = await this.prisma.payment.updateMany({
      where: {
        id: payment.id,
        userId: user.id,
        status: PaymentStatus.PENDING,
        proofFileId: null,
      },
      data: {
        proofFileId: reservation,
      },
    });

    if (reserved.count !== 1) {
      throw new BadRequestException('Чек уже загружается или отправлен');
    }

    try {
      const proofFileId = await this.notifyAdminsAboutWebappProof(
        payment,
        file,
      );

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { proofFileId },
      });

      return {
        ok: true,
        paymentId: payment.id,
        status: 'PENDING_REVIEW',
        message: 'Чек отправлен на проверку',
      };
    } catch (error) {
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          proofFileId: reservation,
        },
        data: {
          proofFileId: null,
        },
      });

      this.logger.error(
        `WebApp proof delivery failed for payment ${payment.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw new ServiceUnavailableException(
        'Не удалось отправить чек. Попробуйте ещё раз',
      );
    }
  }

  private async notifyAdminsAboutWebappProof(
    payment: {
      id: string;
      amount: number;
      bank: string | null;
      user: {
        telegramId: bigint;
        username: string | null;
        firstName: string | null;
        lastName: string | null;
      };
    },
    file: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
    },
  ): Promise<string> {
    const token = this.config.getOrThrow<string>('BOT_TOKEN');

    const adminIds = (
      this.config.get<string>('ADMIN_IDS') || ''
    )
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (adminIds.length === 0) {
      throw new Error('ADMIN_IDS is empty');
    }

    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const username = payment.user.username
      ? `@${payment.user.username}`
      : 'без username';

    const fullName = [
      payment.user.firstName,
      payment.user.lastName,
    ]
      .filter(Boolean)
      .join(' ');

    const bankName =
      payment.bank === 'TBANK' ? 'Т-Банк' : 'Сбербанк';

    const text =
      `💰 <b>Новая заявка на оплату из WebApp</b>\n\n` +
      `Пользователь: <b>${escapeHtml(fullName || username)}</b>\n` +
      `Username: ${escapeHtml(username)}\n` +
      `Telegram ID: <code>${payment.user.telegramId.toString()}</code>\n` +
      `Тариф: <b>Стандарт</b>\n` +
      `Сумма: <b>${(payment.amount / 100).toFixed(0)} ₽</b>\n` +
      `Банк: <b>${bankName}</b>\n` +
      `Payment ID: <code>${payment.id}</code>`;

    const isPdf = file.mimetype === 'application/pdf';
    const mediaField = isPdf ? 'document' : 'photo';
    const mediaMethod = isPdf ? 'sendDocument' : 'sendPhoto';

    const safeFileName =
      file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_') ||
      (isPdf ? 'receipt.pdf' : 'receipt.jpg');

    let telegramFileId = '';
    let delivered = 0;

    for (const adminId of adminIds) {
      try {
        const mediaForm = new FormData();
        mediaForm.append('chat_id', adminId);

        if (telegramFileId) {
          mediaForm.append(mediaField, telegramFileId);
        } else {
          mediaForm.append(
            mediaField,
            new Blob([new Uint8Array(file.buffer)], {
              type: file.mimetype,
            }),
            safeFileName,
          );
        }

        mediaForm.append(
          'caption',
          `Чек по заявке ${payment.id}`,
        );

        const mediaResponse = await fetch(
          `https://api.telegram.org/bot${token}/${mediaMethod}`,
          {
            method: 'POST',
            body: mediaForm,
          },
        );

        const mediaData = (await mediaResponse.json()) as {
          ok?: boolean;
          description?: string;
          result?: {
            document?: { file_id?: string };
            photo?: Array<{ file_id?: string }>;
          };
        };

        if (!mediaResponse.ok || !mediaData.ok) {
          throw new Error(
            mediaData.description ||
              `Telegram media HTTP ${mediaResponse.status}`,
          );
        }

        if (!telegramFileId) {
          telegramFileId = isPdf
            ? mediaData.result?.document?.file_id || ''
            : mediaData.result?.photo?.at(-1)?.file_id || '';
        }

        const messageResponse = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              chat_id: adminId,
              text,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '✅ Подтвердить',
                      callback_data: `manualapprove:${payment.id}`,
                    },
                    {
                      text: '❌ Отклонить',
                      callback_data: `manualreject:${payment.id}`,
                    },
                  ],
                ],
              },
            }),
          },
        );

        const messageData = (await messageResponse.json()) as {
          ok?: boolean;
          description?: string;
        };

        if (!messageResponse.ok || !messageData.ok) {
          throw new Error(
            messageData.description ||
              `Telegram message HTTP ${messageResponse.status}`,
          );
        }

        delivered += 1;
      } catch (error) {
        this.logger.warn(
          `Could not deliver WebApp proof to admin ${adminId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (delivered === 0 || !telegramFileId) {
      throw new Error('Proof was not delivered to admins');
    }

    return telegramFileId;
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
