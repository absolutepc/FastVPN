import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../modules/subscriptions/subscriptions.service';
import { randomBytes } from 'crypto';

export type AdminAction =
  | 'add_days'
  | 'block'
  | 'unblock'
  | 'promo'
  | 'broadcast'
  | 'add_node'
  | null;

export interface SessionData {
  adminAction?: AdminAction;
  adminStep?: number;
  adminData?: Record<string, string>;
}

export type BotContext = Context & SessionFlavor<SessionData>;

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  public bot: Bot<BotContext>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {
    const token = this.config.getOrThrow<string>('BOT_TOKEN');
    this.bot = new Bot<BotContext>(token);
    this.bot.use(session({ initial: (): SessionData => ({}) }));
  }

  async onModuleInit() {
    this.bot.start({
      onStart: (info) => {
        this.logger.log(`Bot @${info.username} started`);
      },
    });

    process.once('SIGINT', () => this.bot.stop());
    process.once('SIGTERM', () => this.bot.stop());
  }

  getMainKeyboard() {
    return {
      keyboard: [
        [{ text: '🛡 Купить' }],
        [{ text: '📱 Мои устройства' }, { text: '💳 Продлить' }],
        [{ text: '🎁 Промокод' }, { text: '👥 Пригласить друга' }],
        [{ text: '💬 Поддержка' }],
      ],
      resize_keyboard: true,
    };
  }

  clearAdminSession(ctx: BotContext) {
    ctx.session.adminAction = null;
    ctx.session.adminStep = 0;
    ctx.session.adminData = {};
  }

  async findOrCreateUser(ctx: BotContext, referralCode?: string) {
    const tgId = BigInt(ctx.from!.id);

    let user = await this.prisma.user.findUnique({
      where: { telegramId: tgId },
    });

    if (user) {
      return { user, isNew: false, referralProcessed: false };
    }

    let referredById: string | undefined;
    let referrerTelegramId: bigint | undefined;

    if (referralCode) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode },
      });
      if (referrer && referrer.telegramId !== tgId && !referrer.isBlocked) {
        referredById = referrer.id;
        referrerTelegramId = referrer.telegramId;
      }
    }

    const newReferralCode = randomBytes(4).toString('hex');

    user = await this.prisma.user.create({
      data: {
        telegramId: tgId,
        username: ctx.from?.username ?? null,
        firstName: ctx.from?.first_name ?? null,
        lastName: ctx.from?.last_name ?? null,
        referralCode: newReferralCode,
        referredById,
      },
    });

    this.logger.log(`New user: ${tgId} (ref: ${referralCode ?? 'none'})`);

    let referralProcessed = false;

    if (referredById) {
      const result = await this.subscriptions.processReferralBonus(user.id, referredById);
      referralProcessed = true;

      if (result.referrerBonus && referrerTelegramId) {
        try {
          await this.bot.api.sendMessage(
            Number(referrerTelegramId),
            `🎉 Друг присоединился по вашей ссылке!\n\nВам начислено <b>+7 дней</b> (Стандарт).`,
            { parse_mode: 'HTML' },
          );
        } catch (e) {
          this.logger.warn(`Could not notify referrer ${referrerTelegramId}`, e);
        }
      }
    }

    return { user, isNew: true, referralProcessed };
  }

  async getActiveSubscription(userId: string) {
    return this.subscriptions.getActiveSubscription(userId);
  }

  get subscriptionsService() {
    return this.subscriptions;
  }

  get prismaService() {
    return this.prisma;
  }
}
