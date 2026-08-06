import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { BotService } from './bot.service';

@Injectable()
export class BotUpdate implements OnModuleInit {
  private readonly logger = new Logger(BotUpdate.name);

  constructor(private readonly botService: BotService) {}

  onModuleInit() {
    const bot = this.botService.bot;

    // /start (с возможным реферальным кодом)
    bot.command('start', async (ctx) => {
      const payload = ctx.match; // код после /start
      const referralCode = payload?.trim() || undefined;

      await this.botService.findOrCreateUser(ctx, referralCode);

      await ctx.reply(
        `👋 Добро пожаловать в <b>Access One</b>!\n\n` +
          `Простой доступ к интернету без сложных настроек.\n\n` +
          `Выберите действие:`,
        {
          parse_mode: 'HTML',
          reply_markup: this.botService.getMainKeyboard(),
        },
      );
    });

    // Главное меню — кнопки
    bot.hears('🛡 Купить', async (ctx) => {
      await ctx.reply(
        `Выберите тариф:\n\n` +
          `<b>Стандарт</b> — 300 ₽ / мес\n` +
          `Обычные серверы\n\n` +
          `<b>Премиум</b> — 600 ₽ / мес\n` +
          `Выделенные серверы (макс. 50 человек) — быстрее и стабильнее`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Стандарт — 300 ₽', callback_data: 'buy:standard' }],
              [{ text: 'Премиум — 600 ₽', callback_data: 'buy:premium' }],
              [{ text: '« Назад', callback_data: 'back:main' }],
            ],
          },
        },
      );
    });

    bot.hears('📱 Мои устройства', async (ctx) => {
      // TODO: показать активную подписку и subscription-ссылку
      await ctx.reply('У вас пока нет активной подписки.\n\nНажмите «🛡 Купить», чтобы оформить.');
    });

    bot.hears('💳 Продлить', async (ctx) => {
      // TODO: продление
      await ctx.reply('Нет активной подписки для продления.');
    });

    bot.hears('🎁 Промокод', async (ctx) => {
      await ctx.reply('Отправьте промокод одним сообщением:');
      // TODO: сценарий ввода промокода
    });

    bot.hears('👥 Пригласить друга', async (ctx) => {
      const user = await this.botService.findOrCreateUser(ctx);
      const botInfo = await bot.api.getMe();
      const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;

      await ctx.reply(
        `👥 <b>Пригласи друга</b>\n\n` +
          `Отправь эту ссылку другу:\n` +
          `<code>${link}</code>\n\n` +
          `Что получите:\n` +
          `• Друг — 7 дней <b>Стандарт</b> бесплатно\n` +
          `• Ты — +7 дней к своей подписке (только Стандарт)`,
        { parse_mode: 'HTML' },
      );
    });

    bot.hears('💬 Поддержка', async (ctx) => {
      await ctx.reply('Напишите ваш вопрос — мы ответим как можно скорее.\n\nИли свяжитесь: @your_support');
      // TODO: пересылка админам
    });

    // Callback-кнопки
    bot.callbackQuery(/^buy:(standard|premium)$/, async (ctx) => {
      const plan = ctx.match![1]; // standard | premium
      await ctx.answerCallbackQuery();

      // TODO: создание платежа ЮKassa
      await ctx.editMessageText(
        `Тариф: <b>${plan === 'premium' ? 'Премиум' : 'Стандарт'}</b>\n\n` +
          `Оплата через ЮKassa скоро будет подключена.`,
        { parse_mode: 'HTML' },
      );
    });

    bot.callbackQuery('back:main', async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply('Главное меню:', {
        reply_markup: this.botService.getMainKeyboard(),
      });
    });

    // Обработка ошибок
    bot.catch((err) => {
      this.logger.error('Bot error', err);
    });

    this.logger.log('Bot handlers registered');
  }
}
