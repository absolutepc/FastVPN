import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../modules/subscriptions/subscriptions.service';
import { randomBytes } from 'crypto';
import { PlanType } from '@prisma/client';

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
  pendingSubGiftToken?: string;
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

  getMainKeyboard(isAdmin = false) {
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    const webAppUrl = appUrl ? `${appUrl}/?v=85` : '';

    const rows: Array<Array<{ text: string; web_app?: { url: string } }>> = [
      [{ text: '🛡 Купить' }],
      [{ text: '📱 Мои устройства' }, { text: '💳 Продлить' }],
      [{ text: '🎁 Промокод' }, { text: '👥 Пригласить друга' }],
      [{ text: '💬 Поддержка' }],
    ];

    if (isAdmin) {
      rows.push([{ text: '🔐 Админ' }]);
    }

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
      const ownerInviteResult =
        referralCode
          ? await this.processOwnerInvite(
              user.id,
              referralCode,
              false,
            )
          : {
              matched: false,
              processed: false,
              days: 0,
            };

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
        ownerInviteProcessed:
          ownerInviteResult.processed,
        ownerInviteDays:
          ownerInviteResult.days,
      };
    }

    let referredById:
      string | undefined;

    let referrerTelegramId:
      bigint | undefined;

    if (
      referralCode &&
      !referralCode.startsWith('gift_') &&
      !referralCode.startsWith('subgift_')
    ) {
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

    const ownerInviteResult =
      referralCode
        ? await this.processOwnerInvite(
            user.id,
            referralCode,
            true,
          )
        : {
            matched: false,
            processed: false,
            days: 0,
          };

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
      ownerInviteProcessed:
        ownerInviteResult.processed,
      ownerInviteDays:
        ownerInviteResult.days,
    };
  }

  async processOwnerInvite(
    userId: string,
    payload: string,
    allowNewRedemption: boolean,
  ) {
    if (!payload.startsWith('gift_')) {
      return {
        matched: false,
        processed: false,
        days: 0,
      };
    }

    const token =
      payload.slice('gift_'.length).trim();

    if (!token) {
      return {
        matched: true,
        processed: false,
        days: 0,
      };
    }

    let redemption =
      await this.prisma.ownerInviteRedemption
        .findUnique({
          where: {
            userId,
          },
          include: {
            invite: true,
          },
        });

    if (!redemption) {
      if (!allowNewRedemption) {
        return {
          matched: true,
          processed: false,
          days: 0,
        };
      }

      const invite =
        await this.prisma.ownerInvite.findUnique({
          where: {
            token,
          },
        });

      if (
        !invite ||
        !invite.isActive
      ) {
        return {
          matched: true,
          processed: false,
          days: 0,
        };
      }

      try {
        redemption =
          await this.prisma.ownerInviteRedemption
            .create({
              data: {
                inviteId: invite.id,
                userId,
                daysGranted: invite.days,
              },
              include: {
                invite: true,
              },
            });
      } catch (error) {
        /*
         * Возможен race двух одновременных /start.
         * userId UNIQUE гарантирует только одно
         * фактическое погашение.
         */
        redemption =
          await this.prisma.ownerInviteRedemption
            .findUnique({
              where: {
                userId,
              },
              include: {
                invite: true,
              },
            });

        if (!redemption) {
          throw error;
        }
      }
    }

    /*
     * Redemption принадлежит конкретной gift-ссылке.
     * Другая owner-ссылка не может использовать
     * уже существующую запись пользователя.
     */
    if (redemption.invite.token !== token) {
      return {
        matched: true,
        processed: false,
        days: 0,
      };
    }

    /*
     * appliedAt означает, что подарок уже был
     * окончательно выдан. Повторная выдача запрещена
     * даже после окончания подарочной подписки.
     */
    if (redemption.appliedAt) {
      return {
        matched: true,
        processed: false,
        days: redemption.daysGranted,
      };
    }

    /*
     * Используем сохранённое daysGranted,
     * поэтому параметры созданной ссылки неизменны.
     */
    const days =
      redemption.daysGranted;

    await this.subscriptions.createSubscription({
      userId,
      plan: PlanType.STANDARD,
      days,
      isTrial: true,
    });

    /*
     * Ставим appliedAt только после успешной
     * выдачи подписки.
     *
     * Если процесс упадёт до этой строки,
     * повторный /start безопасно вызовет
     * createSubscription ещё раз. При уже активной
     * подписке дополнительные дни не начислятся.
     */
    await this.prisma.ownerInviteRedemption.updateMany({
      where: {
        id: redemption.id,
        appliedAt: null,
      },
      data: {
        appliedAt: new Date(),
      },
    });

    return {
      matched: true,
      processed: true,
      days,
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
