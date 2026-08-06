import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';

interface SessionData {
  // пока пусто, позже: текущий шаг, выбранный тариф и т.д.
}

type BotContext = Context & SessionFlavor<SessionData>;

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  public bot: Bot<BotContext>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const token = this.config.getOrThrow<string>('BOT_TOKEN');
    this.bot = new Bot<BotContext>(token);

    this.bot.use(session({ initial: () => ({}) }));
  }

  async onModuleInit() {
    // Регистрация хендлеров происходит в BotUpdate
    // Запуск бота
    this.bot.start({
      onStart: (info) => {
        this.logger.log(`Bot @${info.username} started`);
      },
    });

    // Graceful shutdown
    process.once('SIGINT', () => this.bot.stop());
    process.once('SIGTERM', () => this.bot.stop());
  }

  /** Главное меню */
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

  /** Создать или найти пользователя */
  async findOrCreateUser(ctx: BotContext, referralCode?: string) {
    const tgId = BigInt(ctx.from!.id);

    let user = await this.prisma.user.findUnique({
      where: { telegramId: tgId },
    });

    if (user) return user;

    // Новый пользователь
    let referredById: string | undefined;

    if (referralCode) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode },
      });
      if (referrer && referrer.telegramId !== tgId) {
        referredById = referrer.id;
      }
    }

    const newReferralCode = randomBytes(4).toString('hex'); // 8 символов

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

    this.logger.log(`New user created: ${tgId} (ref: ${referralCode ?? 'none'})`);

    // TODO: если есть referredById — выдать trial приглашённому + бонус пригласившему

    return user;
  }
}
