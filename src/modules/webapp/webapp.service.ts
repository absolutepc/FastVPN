import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { Response } from 'express';
import { execFile } from 'child_process';
import QRCode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PaymentsService } from '../payments/payments.service';
import {
  BonusClaimStatus,
  BonusType,
  PaymentStatus,
  PlanType,
  Prisma,
  SubscriptionStatus,
  UserRole,
} from '@prisma/client';
import { XrayService } from '../xray/xray.service';

@Injectable()
export class WebappService {
  private readonly logger = new Logger(WebappService.name);

  private networkStatusCache: {
    expiresAt: number;
    value: {
      status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
      available: number;
      total: number;
      message: string;
    };
  } | null = null;

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

    const calculatedBuffer =
      Buffer.from(calculated, 'hex');

    const hashBuffer =
      Buffer.from(hash, 'hex');

    if (
      calculatedBuffer.length !== hashBuffer.length ||
      !timingSafeEqual(
        calculatedBuffer,
        hashBuffer,
      )
    ) {
      this.logger.warn('Invalid initData hash');
      throw new UnauthorizedException('Invalid initData');
    }

    const authDate =
      Number(params.get('auth_date') || 0);

    const now =
      Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authDate) ||
      authDate <= 0 ||
      authDate < now - 86400 ||
      authDate > now + 300
    ) {
      throw new UnauthorizedException(
        'initData expired or invalid',
      );
    }

    const userRaw = params.get('user');
    if (!userRaw) throw new UnauthorizedException('No user in initData');
    return JSON.parse(userRaw);
  }

  private isAdminFallbackTelegramId(
    telegramId: number,
  ): boolean {
    const adminIds =
      (this.config.get<string>('ADMIN_IDS') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

    return adminIds.includes(
      String(telegramId),
    );
  }

  private isPrivilegedRole(
    role: UserRole,
  ): boolean {
    return (
      role === UserRole.ADMIN ||
      role === UserRole.OWNER
    );
  }

  private async hasAdminAccess(
    telegramId: number,
  ): Promise<boolean> {
    const user =
      await this.prisma.user.findUnique({
        where: {
          telegramId: BigInt(telegramId),
        },
        select: {
          role: true,
        },
      });

    if (
      user &&
      this.isPrivilegedRole(user.role)
    ) {
      return true;
    }

    return this.isAdminFallbackTelegramId(
      telegramId,
    );
  }

  private async requireAdmin(
    initData: string,
  ) {
    const tg =
      this.validateInitData(initData);

    if (
      !(await this.hasAdminAccess(tg.id))
    ) {
      this.logger.warn(
        `WebApp admin access denied: telegram=${tg.id}`,
      );

      throw new ForbiddenException(
        'Admin access required',
      );
    }

    return tg;
  }

  private async requireOwner(
    initData: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.prisma.user.findUnique({
        where: {
          telegramId: BigInt(tg.id),
        },
        select: {
          id: true,
          role: true,
          isBlocked: true,
        },
      });

    if (
      !user ||
      user.isBlocked ||
      user.role !== UserRole.OWNER
    ) {
      this.logger.warn(
        `WebApp owner access denied: telegram=${tg.id}`,
      );

      throw new ForbiddenException(
        'Owner access required',
      );
    }

    return {
      tg,
      user,
    };
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

  private async getPublicNetworkStatus(): Promise<{
    status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
    available: number;
    total: number;
    message: string;
  }> {
    const now = Date.now();

    if (
      this.networkStatusCache &&
      this.networkStatusCache.expiresAt > now
    ) {
      return this.networkStatusCache.value;
    }

    const maintenanceNodes = new Set(
      (this.config.get<string>('H1CLOUD_MAINTENANCE_NODES') || '')
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    );

    const locationNames: Record<string, string> = {
      FI1: 'Финляндия',
      ES1: 'Испания',
      CH1: 'Швейцария',
      NL1: 'Нидерланды',
      NLBS1: 'Netherlands Обход',
    };

    const networkNodes: Array<{
      nodeKey: string;
      name: string;
      apiOk: boolean;
      inbound: {
        enabled: boolean;
      } | null;
    }> = await this.subscriptions
      .getH1CloudMonitoringStatuses()
      .catch((error) => {
        this.logger.warn(
          `WebApp network status unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        return [];
      });

    const total = networkNodes.length;

    let value: {
      status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
      available: number;
      total: number;
      message: string;
    };

    if (total === 0) {
      value = {
        status: 'UNKNOWN',
        available: 0,
        total: 0,
        message: 'Статус сети временно недоступен',
      };
    } else {
      const maintenance = networkNodes.filter((node) =>
        maintenanceNodes.has(String(node.nodeKey).toUpperCase()),
      );

      const available = networkNodes.filter(
        (node) =>
          !maintenanceNodes.has(String(node.nodeKey).toUpperCase()) &&
          node.apiOk === true &&
          node.inbound?.enabled === true,
      ).length;

      const maintenanceNames = maintenance.map(
        (node) =>
          locationNames[String(node.nodeKey).toUpperCase()] ||
          String(node.name || node.nodeKey),
      );

      if (available === total && maintenance.length === 0) {
        value = {
          status: 'OK',
          available,
          total,
          message: 'Все локации работают',
        };
      } else if (available > 0) {
        value = {
          status: 'DEGRADED',
          available,
          total,
          message:
            maintenanceNames.length > 0
              ? `Техработы: ${maintenanceNames.join(', ')}`
              : 'Часть локаций временно недоступна',
        };
      } else {
        value = {
          status: 'DOWN',
          available: 0,
          total,
          message:
            maintenanceNames.length === total
              ? 'Все локации временно на техработах'
              : 'Сеть временно недоступна',
        };
      }
    }

    this.networkStatusCache = {
      expiresAt: now + 60_000,
      value,
    };

    return value;
  }

  async getNetworkStatus(initData: string) {
    this.validateInitData(initData);

    return this.getPublicNetworkStatus();
  }

  async getCabinet(initData: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);
    const sub = await this.subscriptions.getActiveSubscription(user.id);
    const latestSub = sub ? sub : await this.subscriptions.getLatestSubscription(user.id);
    const devices = sub
      ? await this.prisma.device.findMany({
          where: { subscriptionId: sub.id, isActive: true },
          orderBy: { slot: 'asc' },
        })
      : [];

    const subscriptionState = sub ? 'ACTIVE' : latestSub ? 'EXPIRED' : 'NONE';
    const daysLeft = sub
      ? Math.max(0, Math.ceil((sub.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 0;

    /*
     * DeviceLimitService сканирует свежие Xray-логи
     * каждые 2 минуты и обновляет lastSeenAt.
     *
     * Окно 10 минут учитывает, что активный VPN-туннель
     * может некоторое время не создавать новых Xray-соединений.
     */
    const vpnConnected =
      Boolean(
        sub &&
        devices.some(
          (device) =>
            !device.vpnSyncPending &&
            device.lastSeenAt &&
            Date.now() - device.lastSeenAt.getTime() <= 10 * 60 * 1000,
        ),
      );

    const appUrl = (this.config.get<string>('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');
    const botUsername = this.config.get<string>('BOT_USERNAME') || 'FourStepsVPNbot';

    const referralCount =
      await this.prisma.user.count({
        where: {
          referredById: user.id,
        },
      });

    const referralLink =
      `https://t.me/${botUsername}?start=${user.referralCode}`;

    const referralQrDataUrl =
      await QRCode.toDataURL(referralLink, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 640,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        username: user.username,
        referralCode: user.referralCode,
        avatarUrl: user.avatarUrl,
      },
      role: user.role,
      isAdmin:
        this.isPrivilegedRole(user.role) ||
        this.isAdminFallbackTelegramId(tg.id),
      isOwner:
        user.role === UserRole.OWNER,
      subscriptionState,
      daysLeft,
      deviceLimit: 2,
      deviceUsed: devices.length,
      vpnConnected,
      devices: devices.map((device) => ({
        id: device.id,
        slot: device.slot,
        name: device.name,
        platform: device.platform,
        isActive: device.isActive,
        vpnSyncPending: device.vpnSyncPending,
        subUrl: `${appUrl}/sub/${device.subToken}.txt`,
        createdAt: device.createdAt.toISOString(),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      })),
      // Старое поле оставляем на один релиз для совместимости WebApp-кэша.
      device: devices[0]
        ? {
            id: devices[0].id,
            name: devices[0].name,
            platform: devices[0].platform,
            isActive: devices[0].isActive,
            createdAt: devices[0].createdAt.toISOString(),
            lastSeenAt: devices[0].lastSeenAt?.toISOString() ?? null,
          }
        : null,
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            isTrial: sub.isTrial,
            expiresAt: sub.expiresAt.toISOString(),
            subUrl: devices[0]
              ? `${appUrl}/sub/${devices[0].subToken}.txt`
              : `${appUrl}/sub/${sub.subToken}.txt`,
          }
        : null,
      referralLink,
      referralQrDataUrl,
      referralCount,
      plans: [
        { id: 'STANDARD', name: 'Стандарт', price: 300, description: 'Обычные серверы' },
        { id: 'PREMIUM', name: 'Премиум', price: 600, description: 'Выделенные серверы, макс. 50 человек' },
      ],
    };
  }


  async sendAvatarFile(
    fileName: string,
    res: Response,
  ) {
    if (
      !/^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(
        fileName,
      )
    ) {
      throw new BadRequestException(
        'Invalid avatar file name',
      );
    }

    const absolutePath = join(
      process.cwd(),
      'webapp',
      'uploads',
      'avatars',
      fileName,
    );

    return res.sendFile(absolutePath);
  }


  async uploadAvatar(
    initData: string,
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
      throw new BadRequestException('Avatar file is required');
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Avatar file is too large');
    }

    const extensionByMime: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };

    const extension = extensionByMime[file.mimetype];

    if (!extension) {
      throw new BadRequestException(
        'Only JPEG, PNG and WebP avatars are allowed',
      );
    }

    const uploadDir = join(
      process.cwd(),
      'webapp',
      'uploads',
      'avatars',
    );

    await mkdir(uploadDir, {
      recursive: true,
    });

    const fileName =
      `${user.id}-${randomUUID()}.${extension}`;

    const absolutePath = join(
      uploadDir,
      fileName,
    );

    await writeFile(
      absolutePath,
      file.buffer,
    );

    const avatarUrl =
      `/api/webapp/avatar-file/${fileName}`;

    const previousAvatarUrl =
      user.avatarUrl;

    const updated = await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        avatarUrl,
      },
      select: {
        id: true,
        avatarUrl: true,
      },
    });

    if (
      previousAvatarUrl &&
      (
        previousAvatarUrl.startsWith(
          '/app/uploads/avatars/',
        ) ||
        previousAvatarUrl.startsWith(
          '/api/webapp/avatar-file/',
        )
      )
    ) {
      const previousFileName =
        previousAvatarUrl
          .split('/')
          .pop();

      if (
        previousFileName &&
        previousFileName !== fileName
      ) {
        const previousPath = join(
          uploadDir,
          previousFileName,
        );

        await unlink(previousPath)
          .catch(() => undefined);
      }
    }

    this.logger.log(
      `Avatar updated: user=${user.id}`,
    );

    return {
      ok: true,
      avatarUrl: updated.avatarUrl,
    };
  }


  private getSignedSupportFileUrl(
    attachmentUrl: string | null,
  ): string | null {
    if (!attachmentUrl) {
      return null;
    }

    const fileName =
      attachmentUrl.split('/').pop();

    if (
      !fileName ||
      !/^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(
        fileName,
      )
    ) {
      return null;
    }

    const botToken =
      this.config.get<string>('BOT_TOKEN') || '';

    if (!botToken) {
      throw new Error(
        'BOT_TOKEN is required for support file signing',
      );
    }

    const exp =
      Math.floor(Date.now() / 1000) + 300;

    const payload =
      `${fileName}:${exp}`;

    const signature =
      createHmac('sha256', botToken)
        .update('4steps-support-file-v1')
        .update('\0')
        .update(payload)
        .digest('hex');

    return (
      `/api/webapp/support-file/${fileName}` +
      `?exp=${exp}&sig=${signature}`
    );
  }


  async sendSupportFile(
    fileName: string,
    expRaw: string,
    signature: string,
    res: Response,
  ) {
    if (
      !/^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(
        fileName,
      )
    ) {
      throw new BadRequestException(
        'Invalid support file name',
      );
    }

    const exp =
      Number(expRaw);

    const now =
      Math.floor(Date.now() / 1000);

    if (
      !Number.isInteger(exp) ||
      exp < now ||
      exp > now + 600
    ) {
      throw new UnauthorizedException(
        'Support file link expired',
      );
    }

    const botToken =
      this.config.get<string>('BOT_TOKEN') || '';

    if (!botToken || !signature) {
      throw new UnauthorizedException(
        'Invalid support file link',
      );
    }

    const expected =
      createHmac('sha256', botToken)
        .update('4steps-support-file-v1')
        .update('\0')
        .update(`${fileName}:${exp}`)
        .digest('hex');

    const expectedBuffer =
      Buffer.from(expected, 'hex');

    const providedBuffer =
      Buffer.from(signature, 'hex');

    if (
      expectedBuffer.length !==
        providedBuffer.length ||
      !timingSafeEqual(
        expectedBuffer,
        providedBuffer,
      )
    ) {
      throw new UnauthorizedException(
        'Invalid support file link',
      );
    }

    const absolutePath = join(
      process.cwd(),
      'webapp',
      'uploads',
      'support',
      fileName,
    );

    res.setHeader(
      'Cache-Control',
      'private, no-store',
    );

    return res.sendFile(absolutePath);
  }


  async createSupportTicket(
    initData: string,
    titleRaw: string,
    bodyRaw: string,
    file?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    const title = String(titleRaw || '').trim();
    const body = String(bodyRaw || '').trim();

    if (!title) {
      throw new BadRequestException(
        'Support ticket title is required',
      );
    }

    if (!body) {
      throw new BadRequestException(
        'Support ticket body is required',
      );
    }

    if (title.length > 120) {
      throw new BadRequestException(
        'Support ticket title is too long',
      );
    }

    if (body.length > 5000) {
      throw new BadRequestException(
        'Support ticket body is too long',
      );
    }

    let attachmentUrl: string | null = null;

    if (file?.buffer?.length) {
      if (file.size > 10 * 1024 * 1024) {
        throw new BadRequestException(
          'Support attachment is too large',
        );
      }

      const extensionByMime: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
      };

      const extension =
        extensionByMime[file.mimetype];

      if (!extension) {
        throw new BadRequestException(
          'Only JPEG, PNG and WebP support attachments are allowed',
        );
      }

      const uploadDir = join(
        process.cwd(),
        'webapp',
        'uploads',
        'support',
      );

      await mkdir(
        uploadDir,
        {
          recursive: true,
        },
      );

      const fileName =
        `${user.id}-${randomUUID()}.${extension}`;

      const absolutePath = join(
        uploadDir,
        fileName,
      );

      await writeFile(
        absolutePath,
        file.buffer,
      );

      attachmentUrl =
        `/api/webapp/support-file/${fileName}`;
    }

    const ticket =
      await this.prisma.supportTicket.create({
        data: {
          userId: user.id,
          title,
          body,
          attachmentUrl,
        },
      });

    this.logger.log(
      `Support ticket created: ticket=${ticket.id} user=${user.id}`,
    );

    return {
      ok: true,
      ticket: {
        id: ticket.id,
        title: ticket.title,
        body: ticket.body,
        status: ticket.status,
        attachmentUrl:
          this.getSignedSupportFileUrl(
            ticket.attachmentUrl,
          ),
        createdAt:
          ticket.createdAt.toISOString(),
        updatedAt:
          ticket.updatedAt.toISOString(),
      },
    };
  }


  async getMySupportTickets(
    initData: string,
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    const tickets =
      await this.prisma.supportTicket.findMany({
        where: {
          userId: user.id,
        },
        include: {
          messages: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

    return {
      tickets: tickets.map(
        (ticket) => ({
          id: ticket.id,
          title: ticket.title,
          body: ticket.body,
          status: ticket.status,
          attachmentUrl:
            this.getSignedSupportFileUrl(
              ticket.attachmentUrl,
            ),
          createdAt:
            ticket.createdAt.toISOString(),
          updatedAt:
            ticket.updatedAt.toISOString(),
          messages:
            ticket.messages.map(
              (message) => ({
                id: message.id,
                author: message.author,
                body: message.body,
                createdAt:
                  message.createdAt.toISOString(),
              }),
            ),
        }),
      ),
    };
  }


  async replySupportTicket(
    initData: string,
    ticketId: string,
    bodyRaw: string,
  ) {
    const tg = this.validateInitData(initData);
    const user =
      await this.findOrCreateFromTelegram(tg);

    const body =
      String(bodyRaw || '').trim();

    if (body.length === 0) {
      throw new BadRequestException(
        'Support message body is required',
      );
    }

    if (body.length > 5000) {
      throw new BadRequestException(
        'Support message body is too long',
      );
    }

    const ticket =
      await this.prisma.supportTicket.findFirst({
        where: {
          id: ticketId,
          userId: user.id,
        },
      });

    if (ticket === null) {
      throw new NotFoundException(
        'Support ticket not found',
      );
    }

    if (ticket.status === 'RESOLVED') {
      throw new BadRequestException(
        'Support ticket is resolved',
      );
    }

    const message =
      await this.prisma.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          author: 'USER',
          body,
        },
      });

    return {
      ok: true,
      message: {
        id: message.id,
        author: message.author,
        body: message.body,
        createdAt:
          message.createdAt.toISOString(),
      },
    };
  }


  private getBonusChannel() {
    return {
      username:
        this.config.get<string>(
          'BONUS_CHANNEL_USERNAME',
        ) || '@fourstepsinfo',

      url:
        this.config.get<string>(
          'BONUS_CHANNEL_URL',
        ) || 'https://t.me/fourstepsinfo',
    };
  }


  private async isBonusChannelMember(
    telegramId: bigint | number,
  ): Promise<boolean> {
    const token =
      this.config.getOrThrow<string>('BOT_TOKEN');

    const channel =
      this.getBonusChannel();

    const configuredRoot =
      (
        this.config.get<string>(
          'TELEGRAM_API_ROOT',
        ) || ''
      ).replace(/\/$/, '');

    const apiRoot =
      configuredRoot ||
      'https://api.telegram.org';

    const url =
      `${apiRoot}/bot${token}/getChatMember` +
      `?chat_id=${encodeURIComponent(channel.username)}` +
      `&user_id=${encodeURIComponent(String(telegramId))}`;

    const response =
      await fetch(url);

    const data: any =
      await response
        .json()
        .catch(() => ({}));

    if (
      response.ok === false ||
      data?.ok !== true
    ) {
      throw new ServiceUnavailableException(
        data?.description ||
        'Не удалось проверить подписку на канал',
      );
    }

    const result =
      data.result || {};

    const status =
      String(
        result.status || '',
      ).toLowerCase();

    if (
      status === 'creator' ||
      status === 'administrator' ||
      status === 'member'
    ) {
      return true;
    }

    if (
      status === 'restricted' &&
      result.is_member === true
    ) {
      return true;
    }

    return false;
  }


  private serializeChannelBonus(
    claim: {
      status: BonusClaimStatus;
      bonusDays: number;
      grantedAt: Date | null;
      confirmAfter: Date | null;
      revokedAt: Date | null;
    } | null,
  ) {
    const channel =
      this.getBonusChannel();

    return {
      type: 'TELEGRAM_CHANNEL',
      title: 'Подписка на Telegram-канал',
      description:
        'Подпишитесь на наш Telegram-канал и получите 7 дополнительных дней подписки.',
      channelUsername:
        channel.username,
      channelUrl:
        channel.url,
      bonusDays: 7,

      rule:
        'Бонус закрепляется через 7 дней. Если вы отпишетесь от канала раньше, бонусные 7 дней будут списаны с подписки.',

      status:
        claim?.status || 'AVAILABLE',

      grantedAt:
        claim?.grantedAt?.toISOString() ||
        null,

      confirmAfter:
        claim?.confirmAfter?.toISOString() ||
        null,

      revokedAt:
        claim?.revokedAt?.toISOString() ||
        null,
    };
  }


  async getBonuses(
    initData: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    const claim =
      await this.prisma.bonusClaim.findUnique({
        where: {
          userId_type: {
            userId: user.id,
            type: BonusType.TELEGRAM_CHANNEL,
          },
        },
      });

    return {
      bonuses: [
        this.serializeChannelBonus(
          claim,
        ),
      ],
    };
  }


  async claimTelegramChannelBonus(
    initData: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    /*
     * Существующий claim означает, что право
     * на бонус уже было использовано.
     */
    const existing =
      await this.prisma.bonusClaim.findUnique({
        where: {
          userId_type: {
            userId:
              user.id,

            type:
              BonusType.TELEGRAM_CHANNEL,
          },
        },
      });

    if (existing) {
      return {
        ok:
          true,

        alreadyClaimed:
          true,

        bonus:
          this.serializeChannelBonus(
            existing,
          ),
      };
    }

    /*
     * Telegram API вызываем ДО DB transaction:
     * не держим транзакцию открытой во время
     * внешнего сетевого запроса.
     */
    const isMember =
      await this.isBonusChannelMember(
        user.telegramId,
      );

    if (isMember === false) {
      throw new BadRequestException(
        'Сначала подпишитесь на Telegram-канал',
      );
    }

    let result:
      | {
          claimId: string;
          processed: boolean;
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
              /*
               * Повторно проверяем claim уже внутри
               * Serializable transaction.
               *
               * Это закрывает race между двумя
               * одновременными запросами claim.
               */
              const currentClaim =
                await tx.bonusClaim.findUnique({
                  where: {
                    userId_type: {
                      userId:
                        user.id,

                      type:
                        BonusType.TELEGRAM_CHANNEL,
                    },
                  },
                });

              if (currentClaim) {
                return {
                  claimId:
                    currentClaim.id,

                  processed:
                    false,
                };
              }

              const now =
                new Date();

              const subscription =
                await tx.subscription.findFirst({
                  where: {
                    userId:
                      user.id,

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

              if (!subscription) {
                throw new BadRequestException(
                  'Для получения бонуса нужна активная подписка',
                );
              }

              const baseExpiresAt =
                new Date(
                  subscription.expiresAt,
                );

              const targetExpiresAt =
                new Date(
                  baseExpiresAt.getTime() +
                  7 *
                    24 *
                    60 *
                    60 *
                    1000,
                );

              const confirmAfter =
                new Date(
                  now.getTime() +
                  7 *
                    24 *
                    60 *
                    60 *
                    1000,
                );

              /*
               * КРИТИЧЕСКИ ВАЖНО:
               *
               * entitlement (+7) и claim фиксируются
               * одной DB transaction.
               *
               * Поэтому crash не может оставить
               * подписку продлённой без durable claim
               * или claim без продления.
               */
              const claim =
                await tx.bonusClaim.create({
                  data: {
                    userId:
                      user.id,

                    subscriptionId:
                      subscription.id,

                    type:
                      BonusType.TELEGRAM_CHANNEL,

                    status:
                      BonusClaimStatus.PENDING,

                    bonusDays:
                      7,

                    channelUsername:
                      this.getBonusChannel()
                        .username,

                    baseExpiresAt,
                    targetExpiresAt,

                    grantedAt:
                      now,

                    confirmAfter,

                    syncPending:
                      true,
                  },
                });

              await tx.subscription.update({
                where: {
                  id:
                    subscription.id,
                },

                data: {
                  expiresAt:
                    targetExpiresAt,

                  /*
                   * Сохраняем прежнюю семантику
                   * extendSubscription().
                   */
                  status:
                    SubscriptionStatus.ACTIVE,

                  isTrial:
                    false,
                },
              });

              return {
                claimId:
                  claim.id,

                processed:
                  true,
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
          `Serializable Telegram bonus conflict; retry ${attempt}/3`,
        );
      }
    }

    if (!result) {
      throw new Error(
        'TELEGRAM_BONUS_PROCESSING_FAILED',
      );
    }

    let claim =
      await this.prisma.bonusClaim
        .findUniqueOrThrow({
          where: {
            id:
              result.claimId,
          },
        });

    if (!result.processed) {
      return {
        ok:
          true,

        alreadyClaimed:
          true,

        bonus:
          this.serializeChannelBonus(
            claim,
          ),
      };
    }

    /*
     * DB entitlement уже committed.
     *
     * Ниже только внешняя синхронизация
     * H1Cloud по абсолютному expiresAt.
     *
     * Ошибка здесь НЕ откатывает бонус и
     * НЕ удаляет claim. syncPending позволит
     * cron безопасно повторить операцию.
     */
    try {
      await this.subscriptions
        .syncSubscriptionExpiry(
          claim.subscriptionId,
        );

      claim =
        await this.prisma.bonusClaim.update({
          where: {
            id:
              claim.id,
          },

          data: {
            syncPending:
              false,
          },
        });
    } catch (error) {
      this.logger.warn(
        `Telegram bonus sync pending ${claim.id}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    this.logger.log(
      `Telegram bonus +7 days: user=${user.id}`,
    );

    return {
      ok:
        true,

      bonus:
        this.serializeChannelBonus(
          claim,
        ),
    };
  }

  private async revokeTelegramBonus(
    claimId: string,
  ) {
    let result:
      | {
          revoked: boolean;
          subscriptionId: string | null;
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
              /*
               * Claim и актуальный expiresAt
               * читаются внутри одной Serializable
               * transaction.
               */
              const current =
                await tx.bonusClaim.findUnique({
                  where: {
                    id: claimId,
                  },
                  include: {
                    subscription: true,
                  },
                });

              if (
                !current ||
                current.status !==
                  BonusClaimStatus.PENDING
              ) {
                return {
                  revoked: false,
                  subscriptionId:
                    current?.subscriptionId ||
                    null,
                };
              }

              const revokedExpiresAt =
                new Date(
                  current.subscription
                    .expiresAt.getTime() -
                  current.bonusDays *
                    24 *
                    60 *
                    60 *
                    1000,
                );

              await tx.subscription.update({
                where: {
                  id:
                    current.subscriptionId,
                },
                data: {
                  expiresAt:
                    revokedExpiresAt,
                },
              });

              await tx.bonusClaim.update({
                where: {
                  id:
                    current.id,
                },
                data: {
                  status:
                    BonusClaimStatus.REVOKED,
                  revokedAt:
                    new Date(),
                  syncPending:
                    true,
                },
              });

              await tx.notification.create({
                data: {
                  title:
                    'Бонусные дни списаны',

                  body:
                    'Вы отписались от канала @fourstepsinfo в течение контрольных 7 дней. Поэтому бонусные 7 дней были списаны с вашей подписки.',

                  isActive:
                    true,

                  recipientUserId:
                    current.userId,
                },
              });

              return {
                revoked: true,
                subscriptionId:
                  current.subscriptionId,
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
          error.code === 'P2034';

        if (
          !retryable ||
          attempt === 3
        ) {
          throw error;
        }

        this.logger.warn(
          `Serializable bonus revoke conflict; retry ${attempt}/3`,
        );
      }
    }

    if (
      !result?.revoked ||
      !result.subscriptionId
    ) {
      return;
    }

    /*
     * H1Cloud синхронизируется уже после
     * успешного commit БД.
     */
    try {
      await this.subscriptions
        .syncSubscriptionExpiry(
          result.subscriptionId,
        );

      await this.prisma.bonusClaim.update({
        where: {
          id: claimId,
        },
        data: {
          syncPending:
            false,
        },
      });
    } catch (error) {
      this.logger.error(
        `Bonus revoke sync failed: ${claimId}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    this.logger.warn(
      `Telegram bonus revoked: claim=${claimId}`,
    );
  }

  private subscriptionStateSyncRunning =
    false;

  /*
   * Durable recovery для операций, которые
   * уже committed в БД, но не успели
   * синхронизировать Xray/H1Cloud.
   */
  @Cron('*/2 * * * *')
  async syncPendingSubscriptionStates() {
    if (
      this.subscriptionStateSyncRunning
    ) {
      return;
    }

    this.subscriptionStateSyncRunning =
      true;

    try {
      const result =
        await this.subscriptions
          .syncPendingSubscriptionStates();

      if (
        result.total > 0
      ) {
        this.logger.log(
          `Subscription state recovery: total=${result.total} ok=${result.ok} fail=${result.fail}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Subscription state recovery failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    } finally {
      this.subscriptionStateSyncRunning =
        false;
    }
  }


  @Cron('*/5 * * * *')
  async checkTelegramChannelBonuses() {
    const claims =
      await this.prisma.bonusClaim.findMany({
        where: {
          type:
            BonusType.TELEGRAM_CHANNEL,

          status:
            BonusClaimStatus.PENDING,
        },

        include: {
          user: true,
        },
      });

    const now =
      new Date();

    for (const claim of claims) {
      try {
        const isMember =
          await this.isBonusChannelMember(
            claim.user.telegramId,
          );

        /*
         * Отписался в контрольные 7 дней:
         * снимаем бонус немедленно.
         */
        if (isMember === false) {
          await this.revokeTelegramBonus(
            claim.id,
          );

          continue;
        }

        /*
         * 7 дней прошли, подписка сохранена:
         * бонус становится окончательным.
         */
        if (
          claim.confirmAfter &&
          claim.confirmAfter <= now
        ) {
          await this.prisma.bonusClaim.update({
            where: {
              id: claim.id,
            },

            data: {
              status:
                BonusClaimStatus.CONFIRMED,
            },
          });

          this.logger.log(
            `Telegram bonus confirmed: claim=${claim.id}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Bonus check skipped ${claim.id}: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    }

    /*
     * Повторная синхронизация H1Cloud,
     * если при отзыве была временная ошибка.
     */
    const syncClaims =
      await this.prisma.bonusClaim.findMany({
        where: {
          status: {
            in: [
              BonusClaimStatus.PENDING,
              BonusClaimStatus.REVOKED,
            ],
          },

          syncPending:
            true,
        },
      });

    for (const claim of syncClaims) {
      try {
        await this.subscriptions
          .syncSubscriptionExpiry(
            claim.subscriptionId,
          );

        await this.prisma.bonusClaim.update({
          where: {
            id:
              claim.id,
          },

          data: {
            syncPending:
              false,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Bonus H1 sync retry failed ${claim.id}`,
        );
      }
    }
  }


  async redeemPromoCode(
    initData: string,
    codeRaw: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    if (user.isBlocked) {
      throw new ForbiddenException(
        'Access denied',
      );
    }

    const code =
      String(codeRaw || '')
        .trim()
        .toUpperCase();

    if (
      code.length < 3 ||
      code.length > 64
    ) {
      throw new BadRequestException(
        'Invalid promo code',
      );
    }

    /*
     * PREMIUM capacity — внешний Xray check,
     * поэтому его нельзя помещать внутрь
     * DB transaction.
     *
     * Это только preflight. Все promo-лимиты
     * повторно проверяются уже атомарно ниже.
     */
    const promoPreview =
      await this.prisma.promoCode.findUnique({
        where: {
          code,
        },
        select: {
          plan: true,
        },
      });

    if (
      promoPreview?.plan ===
      PlanType.PREMIUM
    ) {
      const now =
        new Date();

      const activePremium =
        await this.prisma.subscription
          .findFirst({
            where: {
              userId:
                user.id,

              plan:
                PlanType.PREMIUM,

              status: {
                in: [
                  SubscriptionStatus.ACTIVE,
                  SubscriptionStatus.TRIAL,
                ],
              },

              expiresAt: {
                gt: now,
              },
            },
          });

      /*
       * Для продления уже существующей PREMIUM
       * capacity check не требуется — так же,
       * как работала предыдущая реализация.
       */
      if (!activePremium) {
        const can =
          await this.xray
            .canAcceptPremium();

        if (!can) {
          throw new Error(
            'PREMIUM_FULL',
          );
        }
      }
    }

    let applied:
      | {
          promoId: string;
          plan: PlanType;
          days: number;
          mode:
            | 'CREATED'
            | 'RESTORED'
            | 'EXTENDED';
          subscription: {
            id: string;
            plan: PlanType;
            status: SubscriptionStatus;
            expiresAt: Date;
          };
        }
      | undefined;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        applied =
          await this.prisma.$transaction(
            async (tx) => {
              const now =
                new Date();

              const promo =
                await tx.promoCode
                  .findUnique({
                    where: {
                      code,
                    },
                  });

              if (!promo) {
                throw new BadRequestException(
                  'Promo code not found',
                );
              }

              if (!promo.isActive) {
                throw new BadRequestException(
                  'Promo code is disabled',
                );
              }

              if (
                promo.validUntil &&
                promo.validUntil <= now
              ) {
                throw new BadRequestException(
                  'Promo code has expired',
                );
              }

              if (
                promo.maxUses !== null &&
                promo.usedCount >=
                  promo.maxUses
              ) {
                throw new BadRequestException(
                  'Promo code usage limit reached',
                );
              }

              const userUses =
                await tx.promoRedemption
                  .count({
                    where: {
                      promoCodeId:
                        promo.id,
                      userId:
                        user.id,
                    },
                  });

              if (
                userUses >=
                promo.perUserLimit
              ) {
                throw new BadRequestException(
                  'Promo code user limit reached',
                );
              }

              /*
               * Сначала определяем, куда именно
               * будут начислены дни.
               *
               * Всё ниже происходит в ТОЙ ЖЕ
               * Serializable transaction, что и
               * PromoRedemption + usedCount.
               */
              const active =
                await tx.subscription
                  .findFirst({
                    where: {
                      userId:
                        user.id,

                      plan:
                        promo.plan,

                      status: {
                        in: [
                          SubscriptionStatus.ACTIVE,
                          SubscriptionStatus.TRIAL,
                        ],
                      },

                      expiresAt: {
                        gt: now,
                      },
                    },

                    orderBy: {
                      expiresAt:
                        'desc',
                    },
                  });

              let subscription;
              let mode:
                | 'CREATED'
                | 'RESTORED'
                | 'EXTENDED';

              if (active) {
                const newExpires =
                  new Date(
                    active.expiresAt,
                  );

                newExpires.setDate(
                  newExpires.getDate() +
                    promo.days,
                );

                subscription =
                  await tx.subscription
                    .update({
                      where: {
                        id:
                          active.id,
                      },

                      data: {
                        expiresAt:
                          newExpires,

                        status:
                          SubscriptionStatus.ACTIVE,

                        isTrial:
                          false,
                      },
                    });

                mode =
                  'EXTENDED';
              } else {
                const expired =
                  await tx.subscription
                    .findFirst({
                      where: {
                        userId:
                          user.id,

                        plan:
                          promo.plan,

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
                    promo.days,
                );

                if (expired) {
                  subscription =
                    await tx.subscription
                      .update({
                        where: {
                          id:
                            expired.id,
                        },

                        data: {
                          startsAt:
                            now,

                          expiresAt,

                          status:
                            SubscriptionStatus.ACTIVE,

                          isTrial:
                            false,
                        },
                      });

                  mode =
                    'RESTORED';
                } else {
                  subscription =
                    await tx.subscription
                      .create({
                        data: {
                          userId:
                            user.id,

                          plan:
                            promo.plan,

                          status:
                            SubscriptionStatus.ACTIVE,

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
                            false,
                        },
                      });

                  mode =
                    'CREATED';
                }
              }

              /*
               * Факт использования промокода
               * записывается в той же transaction,
               * что и изменение подписки.
               */
              await tx.promoRedemption
                .create({
                  data: {
                    promoCodeId:
                      promo.id,

                    userId:
                      user.id,

                    plan:
                      promo.plan,

                    days:
                      promo.days,
                  },
                });

              /*
               * CAS защищает maxUses при
               * конкурентных активациях.
               */
              const updatedPromo =
                await tx.promoCode
                  .updateMany({
                    where: {
                      id:
                        promo.id,

                      usedCount:
                        promo.usedCount,
                    },

                    data: {
                      usedCount: {
                        increment:
                          1,
                      },
                    },
                  });

              if (
                updatedPromo.count !== 1
              ) {
                throw new Error(
                  'PROMO_CONCURRENT_UPDATE',
                );
              }

              return {
                promoId:
                  promo.id,

                plan:
                  promo.plan,

                days:
                  promo.days,

                mode,

                subscription: {
                  id:
                    subscription.id,

                  plan:
                    subscription.plan,

                  status:
                    subscription.status,

                  expiresAt:
                    subscription.expiresAt,
                },
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
        if (
          error instanceof
          BadRequestException
        ) {
          throw error;
        }

        const retryable =
          (
            error instanceof
              Prisma
                .PrismaClientKnownRequestError &&
            error.code === 'P2034'
          ) ||
          (
            error instanceof Error &&
            error.message ===
              'PROMO_CONCURRENT_UPDATE'
          );

        if (
          !retryable ||
          attempt === 3
        ) {
          if (retryable) {
            throw new BadRequestException(
              'Promo code is busy, try again',
            );
          }

          throw error;
        }

        this.logger.warn(
          `Serializable promo transaction conflict; retry ${attempt}/3`,
        );
      }
    }

    if (!applied) {
      throw new BadRequestException(
        'Promo activation failed',
      );
    }

    /*
     * На этом этапе DB commit уже содержит:
     *
     * - PromoRedemption
     * - promo.usedCount +1
     * - фактически начисленные дни
     *
     * Поэтому сбой/рестарт процесса больше не
     * может оставить "использованный" промокод
     * без подписки.
     *
     * Xray/H1Cloud — post-commit sync.
     */
    try {
      await this.subscriptions
        .syncPaymentSubscription(
          applied.subscription.id,
          applied.days,
          applied.mode,
        );
    } catch (error) {
      /*
       * DB entitlement уже применён.
       * Не откатываем его из-за временной
       * ошибки внешнего VPN backend.
       *
       * Xray/H1Cloud recovery/reconcile
       * восстановят состояние из БД.
       */
      this.logger.error(
        `Promo subscription sync failed: promo=${code} subscription=${applied.subscription.id}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    return {
      ok: true,

      promo: {
        code,

        plan:
          applied.plan,

        days:
          applied.days,
      },

      subscription: {
        id:
          applied.subscription.id,

        plan:
          applied.subscription.plan,

        status:
          applied.subscription.status,

        expiresAt:
          applied.subscription
            .expiresAt
            .toISOString(),
      },
    };
  }

  async getAdminPromoRedemptions(
    initData: string,
    promoId: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const promo =
      await this.prisma.promoCode.findUnique({
        where: {
          id: promoId,
        },
      });

    if (promo === null) {
      throw new NotFoundException(
        'Promo code not found',
      );
    }

    const redemptions =
      await this.prisma.promoRedemption.findMany({
        where: {
          promoCodeId: promo.id,
        },
        include: {
          user: {
            select: {
              id: true,
              telegramId: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

    return {
      ok: true,
      promo: {
        id: promo.id,
        code: promo.code,
        plan: promo.plan,
        days: promo.days,
      },
      redemptions: redemptions.map(
        (item) => ({
          id: item.id,
          plan: item.plan,
          days: item.days,
          createdAt:
            item.createdAt.toISOString(),
          user: {
            id: item.user.id,
            telegramId:
              item.user.telegramId.toString(),
            username:
              item.user.username,
            firstName:
              item.user.firstName,
            lastName:
              item.user.lastName,
          },
        }),
      ),
    };
  }


  async adminDeletePromoCode(
    initData: string,
    promoId: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const promo =
      await this.prisma.promoCode.findUnique({
        where: {
          id: promoId,
        },
        include: {
          _count: {
            select: {
              redemptions: true,
            },
          },
        },
      });

    if (promo === null) {
      throw new NotFoundException(
        'Promo code not found',
      );
    }

    if (
      promo.usedCount > 0 ||
      promo._count.redemptions > 0
    ) {
      throw new BadRequestException(
        'Promo code has redemptions and cannot be deleted',
      );
    }

    await this.prisma.promoCode.delete({
      where: {
        id: promo.id,
      },
    });

    return {
      ok: true,
      deleted: true,
      id: promo.id,
      code: promo.code,
    };
  }


  async adminSetPromoActive(
    initData: string,
    promoId: string,
    isActive: boolean,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const promo =
      await this.prisma.promoCode.findUnique({
        where: {
          id: promoId,
        },
      });

    if (promo === null) {
      throw new NotFoundException(
        'Promo code not found',
      );
    }

    const updated =
      await this.prisma.promoCode.update({
        where: {
          id: promo.id,
        },
        data: {
          isActive,
        },
      });

    return {
      ok: true,
      promo: {
        id: updated.id,
        code: updated.code,
        isActive: updated.isActive,
        updatedAt:
          updated.updatedAt.toISOString(),
      },
    };
  }


  async getAdminPromoCodes(
    initData: string,
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const promos =
      await this.prisma.promoCode.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        include: {
          _count: {
            select: {
              redemptions: true,
            },
          },
        },
      });

    return {
      ok: true,
      promos: promos.map((promo) => ({
        id: promo.id,
        code: promo.code,
        plan: promo.plan,
        days: promo.days,
        maxUses: promo.maxUses,
        usedCount: promo.usedCount,
        redemptionCount:
          promo._count.redemptions,
        perUserLimit:
          promo.perUserLimit,
        validUntil:
          promo.validUntil
            ? promo.validUntil.toISOString()
            : null,
        isActive:
          promo.isActive,
        createdAt:
          promo.createdAt.toISOString(),
        updatedAt:
          promo.updatedAt.toISOString(),
      })),
    };
  }


  async adminCreatePromoCode(
    initData: string,
    input: {
      code?: string;
      plan?: string;
      days?: number;
      maxUses?: number | null;
      perUserLimit?: number;
      validUntil?: string | null;
      isActive?: boolean;
    },
  ) {
    const tg =
      this.validateInitData(initData);

    const user =
      await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const code =
      String(input.code || '')
        .trim()
        .toUpperCase();

    const plan =
      String(input.plan || '')
        .trim()
        .toUpperCase();

    const days =
      Number(input.days);

    const maxUses =
      input.maxUses === null ||
      input.maxUses === undefined
        ? null
        : Number(input.maxUses);

    const perUserLimit =
      input.perUserLimit === undefined
        ? 1
        : Number(input.perUserLimit);

    const isActive =
      input.isActive === undefined
        ? true
        : Boolean(input.isActive);

    if (
      code.length < 3 ||
      code.length > 64
    ) {
      throw new BadRequestException(
        'Promo code length must be 3-64 characters',
      );
    }

    if (
      /^[A-Z0-9_-]+$/.test(code) === false
    ) {
      throw new BadRequestException(
        'Promo code contains invalid characters',
      );
    }

    if (
      plan !== 'STANDARD' &&
      plan !== 'PREMIUM'
    ) {
      throw new BadRequestException(
        'Invalid promo plan',
      );
    }

    if (
      Number.isInteger(days) === false ||
      days < 1 ||
      days > 3650
    ) {
      throw new BadRequestException(
        'Invalid promo days',
      );
    }

    if (
      maxUses !== null &&
      (
        Number.isInteger(maxUses) === false ||
        maxUses < 1
      )
    ) {
      throw new BadRequestException(
        'Invalid promo max uses',
      );
    }

    if (
      Number.isInteger(perUserLimit) === false ||
      perUserLimit < 1 ||
      perUserLimit > 1000
    ) {
      throw new BadRequestException(
        'Invalid promo per-user limit',
      );
    }

    let validUntil: Date | null = null;

    if (
      input.validUntil !== null &&
      input.validUntil !== undefined &&
      String(input.validUntil).trim().length > 0
    ) {
      validUntil =
        new Date(input.validUntil);

      if (
        Number.isNaN(
          validUntil.getTime(),
        )
      ) {
        throw new BadRequestException(
          'Invalid promo expiration date',
        );
      }

      if (
        validUntil.getTime() <= Date.now()
      ) {
        throw new BadRequestException(
          'Promo expiration date must be in the future',
        );
      }
    }

    const existing =
      await this.prisma.promoCode.findUnique({
        where: {
          code,
        },
      });

    if (existing !== null) {
      throw new BadRequestException(
        'Promo code already exists',
      );
    }

    const promo =
      await this.prisma.promoCode.create({
        data: {
          code,
          plan,
          days,
          maxUses,
          perUserLimit,
          validUntil,
          isActive,
          createdByTelegramId:
            BigInt(user.telegramId),
        },
      });

    return {
      ok: true,
      promo: {
        id: promo.id,
        code: promo.code,
        plan: promo.plan,
        days: promo.days,
        maxUses: promo.maxUses,
        usedCount: promo.usedCount,
        perUserLimit:
          promo.perUserLimit,
        validUntil:
          promo.validUntil
            ? promo.validUntil.toISOString()
            : null,
        isActive: promo.isActive,
        createdAt:
          promo.createdAt.toISOString(),
      },
    };
  }


  async getAdminSupportTickets(
    initData: string,
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const tickets =
      await this.prisma.supportTicket.findMany({
        include: {
          user: {
            select: {
              id: true,
              telegramId: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
          messages: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

    return {
      tickets: tickets.map(
        (ticket) => ({
          id: ticket.id,
          title: ticket.title,
          body: ticket.body,
          status: ticket.status,
          attachmentUrl:
            this.getSignedSupportFileUrl(
              ticket.attachmentUrl,
            ),
          createdAt:
            ticket.createdAt.toISOString(),
          updatedAt:
            ticket.updatedAt.toISOString(),
          messages:
            ticket.messages.map(
              (message) => ({
                id: message.id,
                author: message.author,
                body: message.body,
                createdAt:
                  message.createdAt.toISOString(),
              }),
            ),
          user: {
            id: ticket.user.id,
            telegramId:
              ticket.user.telegramId.toString(),
            username:
              ticket.user.username,
            firstName:
              ticket.user.firstName,
            lastName:
              ticket.user.lastName,
          },
        }),
      ),
    };
  }


  async adminReplySupportTicket(
    initData: string,
    ticketId: string,
    bodyRaw: string,
  ) {
    const tg = this.validateInitData(initData);
    const user =
      await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const body =
      String(bodyRaw || '').trim();

    if (body.length === 0) {
      throw new BadRequestException(
        'Support message body is required',
      );
    }

    if (body.length > 5000) {
      throw new BadRequestException(
        'Support message body is too long',
      );
    }

    const ticket =
      await this.prisma.supportTicket.findUnique({
        where: {
          id: ticketId,
        },
      });

    if (ticket === null) {
      throw new NotFoundException(
        'Support ticket not found',
      );
    }

    const message =
      await this.prisma.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          author: 'ADMIN',
          body,
        },
      });

    if (ticket.status === 'NEW') {
      await this.prisma.supportTicket.update({
        where: {
          id: ticket.id,
        },
        data: {
          status: 'IN_PROGRESS',
        },
      });
    }

    return {
      ok: true,
      message: {
        id: message.id,
        author: message.author,
        body: message.body,
        createdAt:
          message.createdAt.toISOString(),
      },
    };
  }


  async updateSupportTicketStatus(
    initData: string,
    ticketId: string,
    statusRaw: string,
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    if (
      !this.isPrivilegedRole(user.role) &&
      !this.isAdminFallbackTelegramId(
        Number(user.telegramId),
      )
    ) {
      throw new ForbiddenException(
        'Admin access required',
      );
    }

    const status =
      String(statusRaw || '')
        .trim()
        .toUpperCase();

    if (
      ![
        'NEW',
        'IN_PROGRESS',
        'RESOLVED',
      ].includes(status)
    ) {
      throw new BadRequestException(
        'Invalid support ticket status',
      );
    }

    const existing =
      await this.prisma.supportTicket.findUnique({
        where: {
          id: ticketId,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'Support ticket not found',
      );
    }

    const updated =
      await this.prisma.supportTicket.update({
        where: {
          id: ticketId,
        },
        data: {
          status:
            status as
              'NEW'
              | 'IN_PROGRESS'
              | 'RESOLVED',
        },
      });

    return {
      ok: true,
      ticket: {
        id: updated.id,
        status: updated.status,
        updatedAt:
          updated.updatedAt.toISOString(),
      },
    };
  }


  async getNotifications(initData: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    const notifications = await this.prisma.notification.findMany({
      where: {
        isActive: true,
        OR: [
          {
            recipientUserId: null,
          },
          {
            recipientUserId: user.id,
          },
        ],
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        reads: {
          where: {
            userId: user.id,
          },
          select: {
            readAt: true,
          },
        },
      },
    });

    const items = notifications.map((notification) => {
      const readAt = notification.reads[0]?.readAt ?? null;

      return {
        id: notification.id,
        title: notification.title,
        body: notification.body,
        createdAt: notification.createdAt.toISOString(),
        readAt: readAt?.toISOString() ?? null,
        isRead: Boolean(readAt),
      };
    });

    const unreadCount = items.filter(
      (notification) => !notification.isRead,
    ).length;

    return {
      unreadCount,
      notifications: items,
    };
  }

  async markNotificationRead(
    initData: string,
    notificationId: string,
  ) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        isActive: true,
        OR: [
          {
            recipientUserId: null,
          },
          {
            recipientUserId: user.id,
          },
        ],
      },
      select: {
        id: true,
      },
    });

    if (!notification) {
      throw new BadRequestException('Notification not found');
    }

    const now = new Date();

    const read = await this.prisma.userNotification.upsert({
      where: {
        userId_notificationId: {
          userId: user.id,
          notificationId,
        },
      },
      create: {
        userId: user.id,
        notificationId,
        readAt: now,
      },
      update: {
        readAt: now,
      },
      select: {
        readAt: true,
      },
    });

    return {
      ok: true,
      notificationId,
      readAt: read.readAt?.toISOString() ?? null,
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

  async createAdminNotification(
    initData: string,
    titleRaw: string,
    bodyRaw: string,
  ) {
    await this.requireAdmin(initData);

    const title = titleRaw.trim();
    const body = bodyRaw.trim();

    if (!title) {
      throw new BadRequestException('Введите заголовок уведомления');
    }

    if (!body) {
      throw new BadRequestException('Введите текст уведомления');
    }

    if (title.length > 120) {
      throw new BadRequestException(
        'Заголовок уведомления слишком длинный',
      );
    }

    if (body.length > 4000) {
      throw new BadRequestException(
        'Текст уведомления слишком длинный',
      );
    }

    const notification = await this.prisma.notification.create({
      data: {
        title,
        body,
        isActive: true,
      },
      select: {
        id: true,
        title: true,
        body: true,
        isActive: true,
        createdAt: true,
      },
    });

    return {
      ok: true,
      notification: {
        ...notification,
        createdAt: notification.createdAt.toISOString(),
      },
    };
  }


  async getAdminDashboard(initData: string) {
    const admin =
      await this.requireAdmin(initData);

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const startOfMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );

    const startOfNextMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1,
      0,
      0,
      0,
      0,
    );

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
          status: SubscriptionStatus.ACTIVE,
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
        where: {
          status: 'SUCCEEDED',
          createdAt: {
            gte: startOfMonth,
            lt: startOfNextMonth,
          },
        },
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

    const h1CloudNodes =
      await this.subscriptions
        .getH1CloudMonitoringStatuses()
        .catch((error) => {
          this.logger.warn(
            `WebApp H1Cloud monitoring unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );

          return [];
        });

    const h1Cloud = h1CloudNodes[0] || {
      nodeKey: 'FI1',
      name: '🇫🇮 Finland',
      apiOk: false,
      clients: 0,
      online: 0,
      expected: 0,
      error: 'Monitoring unavailable',
    };


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
          servers: nodeStatuses.length + h1CloudNodes.length,
      },
      nodes: nodeStatuses,
      h1Cloud,
        h1CloudNodes,
      generatedAt: new Date().toISOString(),
    };
  }


  async createManualWebappPayment(
    initData: string,
    planKey: string,
    bankKey: string,
    durationMonths: number,
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
      durationMonths,
    });

    const phone =
      this.config.get<string>('PAYMENT_PHONE') || '+79626542959';

    const recipient =
      this.config.get<string>('PAYMENT_RECIPIENT') || 'Тамерлан Д.';

    return {
      paymentId: payment.id,
      plan: payment.plan,
      amountRub: Math.round(payment.amount / 100),
      baseAmountRub: Math.round(
        (payment.baseAmount ?? payment.amount) / 100,
      ),
      months: payment.durationMonths,
      days: this.payments.getDurationDays(
        payment.durationMonths,
      ),
      discountPercent:
        this.payments.getDiscountPercent(
          payment.durationMonths,
        ),
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

    const pending = await this.prisma.device.findFirst({
      where: {
        subscriptionId: sub.id,
        isActive: true,
        vpnSyncPending: true,
      },
      orderBy: { slot: 'asc' },
    });

    let device = pending;
    let created = false;

    if (!device) {
      try {
        device = await this.prisma.$transaction(
          async (tx) => {
            const activeDevices = await tx.device.findMany({
              where: {
                subscriptionId: sub.id,
                isActive: true,
              },
              orderBy: { slot: 'asc' },
            });

            if (activeDevices.length >= 2) {
              throw new BadRequestException(
                'К подписке уже привязано два устройства',
              );
            }

            const usedSlots = new Set(activeDevices.map((item) => item.slot));
            const slot = [1, 2].find((value) => !usedSlots.has(value));

            if (!slot) {
              throw new BadRequestException(
                'Нет свободного слота устройства',
              );
            }

            return tx.device.create({
              data: {
                userId: user.id,
                subscriptionId: sub.id,
                uuid: slot === 1 ? sub.uuid : randomUUID(),
                subToken:
                  slot === 1
                    ? sub.subToken
                    : randomBytes(24).toString('hex'),
                slot,
                name: (
                  name ||
                  (slot === 1 ? 'Основное устройство' : 'Второе устройство')
                )
                  .trim()
                  .slice(0, 80),
                platform: platform?.trim().slice(0, 40) || null,
                isActive: true,
                vpnSyncPending: true,
              },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        created = true;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new BadRequestException(
            'Устройство уже добавляется. Обновите страницу.',
          );
        }

        throw error;
      }
    }

    try {
      await this.subscriptions.syncDeviceState(device.id);
    } catch (error) {
      this.logger.error(
        `Device VPN sync failed: user=${user.id} subscription=${sub.id} device=${device.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw new ServiceUnavailableException(
        'Устройство создано, но синхронизация ещё не завершена. Нажмите кнопку повторно.',
      );
    }

    const syncedDevice = await this.prisma.device.findUniqueOrThrow({
      where: { id: device.id },
    });

    this.logger.log(
      `Device activated: user=${user.id} subscription=${sub.id} device=${device.id} slot=${device.slot}`,
    );

    return {
      device: syncedDevice,
      created,
      retried: !created,
    };
  }



  async deleteSecondDevice(initData: string, deviceId: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);
    const sub = await this.subscriptions.getActiveSubscription(user.id);

    if (!sub) {
      throw new BadRequestException('Active subscription required');
    }

    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        userId: user.id,
        subscriptionId: sub.id,
        isActive: true,
      },
    });

    if (!device) {
      throw new NotFoundException('Устройство не найдено');
    }

    if (device.slot !== 2) {
      throw new BadRequestException(
        'Основное устройство удалить нельзя',
      );
    }

    try {
      await this.subscriptions.removeSecondDeviceAccess(device.id);
    } catch (error) {
      this.logger.error(
        `Second device removal failed: user=${user.id} subscription=${sub.id} device=${device.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw new ServiceUnavailableException(
        'Не удалось отключить устройство на всех серверах. Попробуйте ещё раз.',
      );
    }

    await this.prisma.device.delete({
      where: { id: device.id },
    });

    this.logger.log(
      `Second device deleted: user=${user.id} subscription=${sub.id} device=${device.id}`,
    );

    return {
      deleted: true,
      deviceId: device.id,
      slot: device.slot,
    };
  }

  async createOwnerInvite(
    initData: string,
    daysRaw: number,
  ) {
    const { user } =
      await this.requireOwner(initData);

    const days =
      Number(daysRaw);

    if (
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    ) {
      throw new BadRequestException(
        'Days must be between 1 and 365',
      );
    }

    const token =
      randomBytes(18)
        .toString('base64url');

    const invite =
      await this.prisma.ownerInvite.create({
        data: {
          token,
          days,
          createdById: user.id,
        },
        select: {
          id: true,
          token: true,
          days: true,
          isActive: true,
          createdAt: true,
        },
      });

    const botUsername =
      this.config.get<string>('BOT_USERNAME') ||
      'FourStepsVPNbot';

    return {
      ...invite,
      payload: `gift_${invite.token}`,
      link:
        `https://t.me/${botUsername}?start=gift_${invite.token}`,
    };
  }

  async getOwnerInvites(
    initData: string,
  ) {
    const { user } =
      await this.requireOwner(initData);

    const invites =
      await this.prisma.ownerInvite.findMany({
        where: {
          createdById: user.id,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 100,
        select: {
          id: true,
          token: true,
          days: true,
          isActive: true,
          createdAt: true,
          _count: {
            select: {
              redemptions: true,
            },
          },
        },
      });

    const botUsername =
      this.config.get<string>('BOT_USERNAME') ||
      'FourStepsVPNbot';

    return invites.map((invite) => ({
      id: invite.id,
      token: invite.token,
      payload: `gift_${invite.token}`,
      link:
        `https://t.me/${botUsername}?start=gift_${invite.token}`,
      days: invite.days,
      isActive: invite.isActive,
      createdAt: invite.createdAt,
      uses: invite._count.redemptions,
    }));
  }

  async setOwnerInviteActive(
    initData: string,
    inviteId: string,
    isActive: boolean,
  ) {
    const { user } =
      await this.requireOwner(initData);

    const invite =
      await this.prisma.ownerInvite.findFirst({
        where: {
          id: inviteId,
          createdById: user.id,
        },
        select: {
          id: true,
        },
      });

    if (!invite) {
      throw new NotFoundException(
        'Owner invite not found',
      );
    }

    return this.prisma.ownerInvite.update({
      where: {
        id: invite.id,
      },
      data: {
        isActive,
      },
      select: {
        id: true,
        days: true,
        isActive: true,
      },
    });
  }

}
