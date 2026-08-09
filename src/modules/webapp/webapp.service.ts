import { Injectable, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PaymentsService } from '../payments/payments.service';
import { PlanType } from '@prisma/client';
import { randomBytes } from 'crypto';

@Injectable()
export class WebappService {
  private readonly logger = new Logger(WebappService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly payments: PaymentsService,
  ) {}

  /** Validate Telegram WebApp initData (HMAC-SHA256) */
  validateInitData(initData: string): { id: number; username?: string; first_name?: string; last_name?: string } {
    if (!initData) {
      throw new UnauthorizedException('No initData');
    }

    // Local preview: ?mock=TELEGRAM_ID → initData "mock:123"
    if (initData.startsWith('mock:')) {
      const mockId = Number(initData.replace('mock:', '')) || 1;
      return { id: mockId, first_name: 'Dev', username: 'devuser' };
    }

    const botToken = this.config.getOrThrow<string>('BOT_TOKEN');
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      throw new UnauthorizedException('No hash');
    }

    params.delete('hash');
    const entries = Array.from(params.entries());
    entries.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculated !== hash) {
      this.logger.warn('Invalid initData hash');
      throw new UnauthorizedException('Invalid initData');
    }

    const authDate = Number(params.get('auth_date') || 0);
    if (authDate && Date.now() / 1000 - authDate > 86400) {
      throw new UnauthorizedException('initData expired');
    }

    const userRaw = params.get('user');
    if (!userRaw) {
      throw new UnauthorizedException('No user in initData');
    }

    const user = JSON.parse(userRaw) as {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };

    return user;
  }

  async findOrCreateFromTelegram(tg: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  }) {
    const telegramId = BigInt(tg.id);

    let user = await this.prisma.user.findUnique({
      where: { telegramId },
    });

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
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          username: tg.username ?? user.username,
          firstName: tg.first_name ?? user.firstName,
          lastName: tg.last_name ?? user.lastName,
        },
      });
    }

    if (user.isBlocked) {
      throw new ForbiddenException('User blocked');
    }

    return user;
  }

  async getCabinet(initData: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);
    const sub = await this.subscriptions.getActiveSubscription(user.id);

    const latestSub = sub
      ? sub
      : await this.subscriptions.getLatestSubscription(user.id);

    const subscriptionState = sub
      ? 'ACTIVE'
      : latestSub
        ? 'EXPIRED'
        : 'NONE';

    const daysLeft = sub
      ? Math.max(
          0,
          Math.ceil(
            (sub.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
          ),
        )
      : 0;

    const appUrl = (this.config.get<string>('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');
    const botUsername = this.config.get<string>('BOT_USERNAME') || 'FourStepsVPNbot';

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        username: user.username,
        referralCode: user.referralCode,
      },
      subscriptionState,
      daysLeft,
      deviceLimit: 1,
      deviceUsed: sub ? 1 : 0,
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            isTrial: sub.isTrial,
            expiresAt: sub.expiresAt.toISOString(),
            subUrl: `${appUrl}/sub/${sub.subToken}`,
          }
        : null,
      referralLink: `https://t.me/${botUsername}?start=${user.referralCode}`,
      plans: [
        {
          id: 'STANDARD',
          name: 'Стандарт',
          price: 300,
          description: 'Обычные серверы',
        },
        {
          id: 'PREMIUM',
          name: 'Премиум',
          price: 600,
          description: 'Выделенные серверы, макс. 50 человек',
        },
      ],
    };
  }

  async createPayment(initData: string, planKey: string) {
    const tg = this.validateInitData(initData);
    const user = await this.findOrCreateFromTelegram(tg);

    const plan = planKey === 'PREMIUM' || planKey === 'premium' ? PlanType.PREMIUM : PlanType.STANDARD;

    const result = await this.payments.createPayment({
      userId: user.id,
      plan,
    });

    return {
      confirmationUrl: result.confirmationUrl,
      amount: result.amount,
      plan,
    };
  }
}
