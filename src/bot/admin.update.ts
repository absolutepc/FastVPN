import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlanType, SubscriptionStatus } from '@prisma/client';

@Injectable()
export class AdminUpdate implements OnModuleInit {
  private readonly logger = new Logger(AdminUpdate.name);
  private adminIds: Set<string>;

  constructor(
    private readonly botService: BotService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const raw = this.config.get<string>('ADMIN_IDS') || '';
    this.adminIds = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }

  private isAdmin(telegramId: number | undefined): boolean {
    if (!telegramId) return false;
    return this.adminIds.has(String(telegramId));
  }

  private adminKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '📊 Dashboard', callback_data: 'admin:dashboard' },
          { text: '🛠 Управление', callback_data: 'admin:manage' },
        ],
        [{ text: '📡 Мониторинг', callback_data: 'admin:monitor' }],
      ],
    };
  }

  private manageKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '➕ Добавить сервер', callback_data: 'admin:add_node' },
          { text: '➖ Удалить сервер', callback_data: 'admin:del_node' },
        ],
        [
          { text: '🎟 Создать промокод', callback_data: 'admin:promo' },
          { text: '📅 Начислить дни', callback_data: 'admin:add_days' },
        ],
        [
          { text: '📢 Рассылка', callback_data: 'admin:broadcast' },
          { text: '🚫 Заблокировать', callback_data: 'admin:block' },
        ],
        [{ text: '« Назад', callback_data: 'admin:menu' }],
      ],
    };
  }

  onModuleInit() {
    const bot = this.botService.bot;

    // /admin
    bot.command('admin', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) {
        return ctx.reply('Нет доступа.');
      }

      await ctx.reply('🔐 <b>Панель администратора</b>', {
        parse_mode: 'HTML',
        reply_markup: this.adminKeyboard(),
      });
    });

    // Главное меню админа
    bot.callbackQuery('admin:menu', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText('🔐 <b>Панель администратора</b>', {
        parse_mode: 'HTML',
        reply_markup: this.adminKeyboard(),
      });
    });

    // Dashboard
    bot.callbackQuery('admin:dashboard', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();

      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const [usersCount, activeSubs, trialSubs, revenue, expiringToday] = await Promise.all([
        this.prisma.user.count(),
        this.prisma.subscription.count({
          where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] }, expiresAt: { gt: now } },
        }),
        this.prisma.subscription.count({
          where: { status: SubscriptionStatus.TRIAL, expiresAt: { gt: now } },
        }),
        this.prisma.payment.aggregate({
          where: { status: 'SUCCEEDED' },
          _sum: { amount: true },
        }),
        this.prisma.subscription.count({
          where: {
            status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
            expiresAt: { gte: startOfDay, lte: endOfDay },
          },
        }),
      ]);

      const revenueRub = ((revenue._sum.amount || 0) / 100).toFixed(0);

      await ctx.editMessageText(
        `📊 <b>Dashboard</b>\n\n` +
          `👥 Пользователей: <b>${usersCount}</b>\n` +
          `✅ Активных подписок: <b>${activeSubs}</b>\n` +
          `🎁 Trial: <b>${trialSubs}</b>\n` +
          `💰 Доход (всего): <b>${revenueRub} ₽</b>\n` +
          `⏰ Истекают сегодня: <b>${expiringToday}</b>\n\n` +
          `🟢 Онлайн / Нагрузка — скоро (мониторинг нод)`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Назад', callback_data: 'admin:menu' }]],
          },
        },
      );
    });

    // Управление
    bot.callbackQuery('admin:manage', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText('🛠 <b>Управление</b>', {
        parse_mode: 'HTML',
        reply_markup: this.manageKeyboard(),
      });
    });

    // Заглушки действий (логика будет добавлена по мере разработки)
    const stubs: Record<string, string> = {
      'admin:add_node': '➕ Добавление сервера — в следующем этапе (форма: name, host, type, Reality keys).',
      'admin:del_node': '➖ Удаление сервера — выберите ноду из списка (скоро).',
      'admin:promo': '🎟 Создание промокода — форма code / скидка / лимит (скоро).',
      'admin:add_days': '📅 Начисление дней — укажите telegram_id и количество дней (скоро).',
      'admin:broadcast': '📢 Рассылка — отправьте текст следующим сообщением (скоро).',
      'admin:block': '🚫 Блокировка — укажите telegram_id (скоро). Удалит UUID с нод + isBlocked=true.',
      'admin:monitor': '📡 Мониторинг нод (CPU/RAM/Ping/Xray) — каждые 30 сек, отображение скоро.',
    };

    for (const [data, text] of Object.entries(stubs)) {
      bot.callbackQuery(data, async (ctx) => {
        if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
          reply_markup: {
            inline_keyboard: [[{ text: '« Назад', callback_data: 'admin:manage' }]],
          },
        });
      });
    }

    this.logger.log('Admin handlers registered');
  }
}
