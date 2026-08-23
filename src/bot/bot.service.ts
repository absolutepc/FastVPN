import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../modules/subscriptions/subscriptions.service';
import { randomBytes } from 'crypto';

export type AdminAction =
  | 'find_user'
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
    // Optional local Telegram Bot API server (bypass blocked api.telegram.org)
    // Example: TELEGRAM_API_ROOT=http://127.0.0.1:8081
    const apiRoot = (this.config.get<string>('TELEGRAM_API_ROOT') || '').replace(/\/$/, '');

    this.bot = apiRoot
      ? new Bot<BotContext>(token, {
          client: {
            apiRoot,
          },
        })
      : new Bot<BotContext>(token);

    if (apiRoot) {
      this.logger.log(`Using custom Telegram API root: ${apiRoot}`);
    }

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
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    const webAppUrl = appUrl ? `${appUrl}/` : '';

    const rows: Array<Array<{ text: string; web_app?: { url: string } }>> = [
      [{ text: '🛡 Купить' }],
      [{ text: '📱 Мои устройства' }, { text: '💳 Продлить' }],
      [{ text: '🎁 Промокод' }, { text: '👥 Пригласить друга' }],
      [{ text: '💬 Поддержка' }],
    ];

    // WebApp button only works over HTTPS in Telegram
    if (webAppUrl.startsWith('https://')) {
      rows.unshift([{ text: '🏠 Кабинет' }]);
    }

    return {
      keyboard: rows,
      resize_keyboard: true,
    };
  }

  clearAdminSession(ctx: BotContext) {
    ctx.session.adminAction = null;
    ctx.session.adminStep = 0;
    ctx.session.adminData = {};
  }

  private async notifyReferrer(
    telegramId: bigint,
  ) {
    try {
      await this.bot.api.sendMessage(
        Number(telegramId),
        `🎉 Друг присоединился по вашей ссылке!\n\nВам начислено <b>+7 дней</b> (Стандарт).`,
        {
          parse_mode:
            'HTML',
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not notify referrer ${telegramId}`,
        error,
      );
    }
  }


  async findOrCreateUser(
    ctx: BotContext,
    referralCode?: string,
  ) {
    const tgId =
      BigInt(ctx.from!.id);

    let user =
      await this.prisma.user.findUnique({
        where: {
          telegramId:
            tgId,
        },
      });

    /*
     * ВАЖНО:
     *
     * существующий user может быть результатом
     * crash между user.create() и referral processing.
     *
     * Поэтому referredById теперь всегда
     * безопасно проверяем через идемпотентный ledger.
     */
    if (user) {
      let referralProcessed =
        false;

      if (user.referredById) {
        const result =
          await this.subscriptions
            .processReferralBonus(
              user.id,
              user.referredById,
            );

        referralProcessed =
          result.processed;

        if (
          result.processed &&
          result.referrerBonus
        ) {
          const referrer =
            await this.prisma.user
              .findUnique({
                where: {
                  id:
                    user.referredById,
                },

                select: {
                  telegramId:
                    true,
                },
              });

          if (referrer) {
            await this.notifyReferrer(
              referrer.telegramId,
            );
          }
        }
      }

      return {
        user,
        isNew:
          false,
        referralProcessed,
      };
    }

    let referredById:
      string | undefined;

    let referrerTelegramId:
      bigint | undefined;

    if (referralCode) {
      const referrer =
        await this.prisma.user
          .findUnique({
            where: {
              referralCode,
            },
          });

      if (
        referrer &&
        referrer.telegramId !==
          tgId &&
        !referrer.isBlocked
      ) {
        referredById =
          referrer.id;

        referrerTelegramId =
          referrer.telegramId;
      }
    }

    const newReferralCode =
      randomBytes(4)
        .toString('hex');

    /*
     * User и referral entitlement специально
     * не обязаны быть одной transaction.
     *
     * Если процесс упадёт сразу после user.create,
     * следующий /start увидит referredById
     * и безопасно догонит processReferralBonus().
     */
    user =
      await this.prisma.user.create({
        data: {
          telegramId:
            tgId,

          username:
            ctx.from?.username ??
            null,

          firstName:
            ctx.from?.first_name ??
            null,

          lastName:
            ctx.from?.last_name ??
            null,

          referralCode:
            newReferralCode,

          referredById,
        },
      });

    this.logger.log(
      `New user: ${tgId} (ref: ${referralCode ?? 'none'})`,
    );

    let referralProcessed =
      false;

    if (referredById) {
      const result =
        await this.subscriptions
          .processReferralBonus(
            user.id,
            referredById,
          );

      referralProcessed =
        result.processed;

      if (
        result.processed &&
        result.referrerBonus &&
        referrerTelegramId
      ) {
        await this.notifyReferrer(
          referrerTelegramId,
        );
      }
    }

    return {
      user,
      isNew:
        true,
      referralProcessed,
    };
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
