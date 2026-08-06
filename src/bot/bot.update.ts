import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { BotService } from './bot.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BotUpdate implements OnModuleInit {
  private readonly logger = new Logger(BotUpdate.name);

  constructor(
    private readonly botService: BotService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const bot = this.botService.bot;

    // /start (с возможным реферальным кодом)
    bot.command('start', async (ctx) => {
      const payload = ctx.match?.trim() || undefined;

      const { user, isNew, referralProcessed } = await this.botService.findOrCreateUser(
        ctx,
        payload,
      );

      if (user.isBlocked) {
        return ctx.reply('Доступ ограничен. Обратитесь в поддержку.');
      }

      let welcome =
        `👋 Добро пожаловать в <b>Access One</b>!\n\n` +
        `Простой доступ к интернету без сложных настроек.`;

      if (isNew && referralProcessed) {
        welcome +=
          `\n\n🎁 Вам активирован <b>пробный период 7 дней</b> (Стандарт)!\n` +
          `Нажмите «📱 Мои устройства», чтобы получить ссылку.`;
      }

      welcome += `\n\nВыберите действие:`;

      await ctx.reply(welcome, {
        parse_mode: 'HTML',
        reply_markup: this.botService.getMainKeyboard(),
      });
    });

    // Главное меню
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
      const { user } = await this.botService.findOrCreateUser(ctx);

      if (user.isBlocked) {
        return ctx.reply('Доступ ограничен.');
      }

      const sub = await this.botService.getActiveSubscription(user.id);

      if (!sub) {
        return ctx.reply(
          'У вас пока нет активной подписки.\n\nНажмите «🛡 Купить», чтобы оформить.',
        );
      }

      const appUrl = this.config.get<string>('APP_URL') || 'https://your-domain.com';
      const subUrl = `${appUrl}/sub/${sub.subToken}`;
      const expires = sub.expiresAt.toLocaleDateString('ru-RU');
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';
      const trialMark = sub.isTrial ? ' (пробный)' : '';

      await ctx.reply(
        `📱 <b>Ваша подписка</b>\n\n` +
          `Тариф: <b>${planName}</b>${trialMark}\n` +
          `Действует до: <b>${expires}</b>\n\n` +
          `🔗 Subscription-ссылка:\n<code>${subUrl}</code>\n\n` +
          `👇 Выберите приложение`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🍏 Happ', callback_data: 'app:happ' },
                { text: '📱 v2RayTun', callback_data: 'app:v2raytun' },
              ],
              [
                { text: '🤖 Hiddify', callback_data: 'app:hiddify' },
                { text: '📷 QR', callback_data: 'app:qr' },
              ],
              [{ text: '📋 Скопировать ссылку', callback_data: 'app:copy' }],
            ],
          },
        },
      );
    });

    bot.hears('💳 Продлить', async (ctx) => {
      const { user } = await this.botService.findOrCreateUser(ctx);
      const sub = await this.botService.getActiveSubscription(user.id);

      if (!sub) {
        return ctx.reply('Нет активной подписки для продления.\nНажмите «🛡 Купить».');
      }

      // Пока без ЮKassa — заглушка
      await ctx.reply(
        `Текущий тариф: <b>${sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт'}</b>\n` +
          `Действует до: ${sub.expiresAt.toLocaleDateString('ru-RU')}\n\n` +
          `Оплата через ЮKassa будет подключена позже.`,
        { parse_mode: 'HTML' },
      );
    });

    bot.hears('🎁 Промокод', async (ctx) => {
      await ctx.reply('Отправьте промокод одним сообщением:');
    });

    bot.hears('👥 Пригласить друга', async (ctx) => {
      const { user } = await this.botService.findOrCreateUser(ctx);
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
      await ctx.reply(
        'Напишите ваш вопрос — мы ответим как можно скорее.\n\nИли свяжитесь: @your_support',
      );
    });

    // Выбор тарифа
    bot.callbackQuery(/^buy:(standard|premium)$/, async (ctx) => {
      const plan = ctx.match![1];
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `Тариф: <b>${plan === 'premium' ? 'Премиум' : 'Стандарт'}</b>\n\n` +
          `Оплата через ЮKassa скоро будет подключена.`,
        { parse_mode: 'HTML' },
      );
    });

    // Приложения (заглушки с инструкцией)
    bot.callbackQuery(/^app:(happ|v2raytun|hiddify|qr|copy)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const app = ctx.match![1];

      const { user } = await this.botService.findOrCreateUser(ctx);
      const sub = await this.botService.getActiveSubscription(user.id);
      if (!sub) {
        return ctx.reply('Нет активной подписки.');
      }

      const appUrl = this.config.get<string>('APP_URL') || 'https://your-domain.com';
      const subUrl = `${appUrl}/sub/${sub.subToken}`;

      if (app === 'copy' || app === 'qr') {
        return ctx.reply(`🔗 Ваша ссылка:\n<code>${subUrl}</code>`, {
          parse_mode: 'HTML',
        });
      }

      const instructions: Record<string, string> = {
        happ:
          `🍏 <b>Happ</b>\n\n1. Скачайте Happ\n2. Нажмите «+» → «Из буфера» или вставьте ссылку\n3. Вставьте:\n<code>${subUrl}</code>`,
        v2raytun:
          `📱 <b>v2RayTun</b>\n\n1. Откройте v2RayTun\n2. «+» → Subscribe\n3. Вставьте:\n<code>${subUrl}</code>`,
        hiddify:
          `🤖 <b>Hiddify</b>\n\n1. Откройте Hiddify\n2. «+» → Добавить из буфера\n3. Вставьте:\n<code>${subUrl}</code>`,
      };

      await ctx.reply(instructions[app], { parse_mode: 'HTML' });
    });

    bot.callbackQuery('back:main', async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply('Главное меню:', {
        reply_markup: this.botService.getMainKeyboard(),
      });
    });

    bot.catch((err) => {
      this.logger.error('Bot error', err);
    });

    this.logger.log('Bot handlers registered');
  }
}
