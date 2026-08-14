import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { BotService, BotContext } from './bot.service';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../modules/payments/payments.service';
import { PaymentStatus, PlanType } from '@prisma/client';

@Injectable()
export class BotUpdate implements OnModuleInit {
  private readonly logger = new Logger(BotUpdate.name);

  constructor(
    private readonly botService: BotService,
    private readonly config: ConfigService,
    private readonly payments: PaymentsService,
  ) {}

  private isAdmin(telegramId: number | undefined): boolean {
    if (!telegramId) return false;

    const raw = this.config.get<string>('ADMIN_IDS') || '';
    return raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(String(telegramId));
  }

  private getAdminIds(): number[] {
    const raw = this.config.get<string>('ADMIN_IDS') || '';

    return raw
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  onModuleInit() {
    const bot = this.botService.bot;

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
        `👋 Добро пожаловать в <b>4StepsVPN</b>!\n\n` +
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

    bot.hears('🏠 Кабинет', async (ctx) => {
      const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');

      if (!appUrl.startsWith('https://')) {
        return ctx.reply('Кабинет временно недоступен.');
      }

      await ctx.reply('Откройте личный кабинет:', {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🏠 Открыть кабинет',
                web_app: { url: `${appUrl}/` },
              },
            ],
          ],
        },
      });
    });

    bot.hears('🛡 Купить', async (ctx) => {
      await ctx.reply(
        `🛡 <b>4StepsVPN — Стандарт</b>\n\n` +
          `💰 <b>300 ₽ / 30 дней</b>\n` +
          `📱 1 устройство\n` +
          `🖥 Серверы тарифа Стандарт\n\n` +
          `Премиум временно недоступен.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Купить Стандарт — 300 ₽', callback_data: 'buy:standard' }],
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

      const appUrl = (this.config.get<string>('APP_URL') || 'https://your-domain.com').replace(
        /\/$/,
        '',
      );
      const subUrl = `${appUrl}/sub/${sub.subToken}.txt`;
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

      if (sub.plan === PlanType.PREMIUM) {
        return ctx.reply(
          'Премиум временно недоступен для продления. Обратитесь в поддержку.',
        );
      }

      await ctx.reply(
        `Продление: <b>Стандарт</b>\n` +
          `Действует до: ${sub.expiresAt.toLocaleDateString('ru-RU')}\n\n` +
          `Стоимость: <b>300 ₽</b> / 30 дней`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Оплатить 300 ₽', callback_data: 'buy:standard' }],
              [{ text: '« Назад', callback_data: 'back:main' }],
            ],
          },
        },
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

    bot.callbackQuery(/^buy:(standard|premium)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const planKey = ctx.match![1];

      if (planKey === 'premium') {
        return ctx.editMessageText(
          '👑 Премиум пока недоступен.\n\nСейчас доступен тариф Стандарт — 300 ₽.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🛡 Купить Стандарт — 300 ₽', callback_data: 'buy:standard' }],
                [{ text: '« Назад', callback_data: 'back:main' }],
              ],
            },
          },
        );
      }

      const { user } = await this.botService.findOrCreateUser(ctx);

      if (user.isBlocked) {
        return ctx.editMessageText('Доступ ограничен.');
      }

      await ctx.editMessageText(
        '🛡 <b>4StepsVPN — Стандарт</b>\n\n' +
          '💰 Стоимость: <b>300 ₽ / 30 дней</b>\n' +
          '📱 1 устройство\n\n' +
          'Выберите банк для оплаты:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🟡 Т-Банк', callback_data: 'manualpay:tbank' }],
              [{ text: '🟢 Сбербанк', callback_data: 'manualpay:sber' }],
              [{ text: '« Назад', callback_data: 'back:main' }],
            ],
          },
        },
      );
    });

    bot.callbackQuery(/^manualpay:(tbank|sber)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const bankKey = ctx.match![1] as 'tbank' | 'sber';
      const bank = bankKey === 'tbank' ? 'TBANK' : 'SBER';
      const bankName = bankKey === 'tbank' ? 'Т-Банк' : 'Сбербанк';

      const { user } = await this.botService.findOrCreateUser(ctx);

      if (user.isBlocked) {
        return ctx.editMessageText('Доступ ограничен.');
      }

      try {
        const payment = await this.payments.createManualPayment({
          userId: user.id,
          plan: PlanType.STANDARD,
          bank,
        });

        const phone = this.config.get<string>('PAYMENT_PHONE') || '+79626542959';
        const recipient = this.config.get<string>('PAYMENT_RECIPIENT') || 'Тамерлан Д.';

        await ctx.editMessageText(
          `💳 <b>Оплата 4StepsVPN</b>\n\n` +
            `Тариф: <b>Стандарт</b>\n` +
            `Срок: <b>30 дней</b>\n` +
            `Сумма: <b>300 ₽</b>\n` +
            `Банк: <b>${bankName}</b>\n\n` +
            `Переведите <b>300 ₽</b> по номеру телефона:\n` +
            `<code>${phone}</code>\n` +
            `Получатель: <b>${recipient}</b>\n\n` +
            `⚠️ Перед переводом убедитесь, что выбран <b>${bankName}</b> и получатель совпадает.\n\n` +
            `После оплаты нажмите «✅ Я оплатил».`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Я оплатил', callback_data: `manualpaid:${payment.id}` }],
                [{ text: '« Назад', callback_data: 'buy:standard' }],
              ],
            },
          },
        );
      } catch (e) {
        this.logger.error('Create manual payment error', e);
        await ctx.editMessageText('Не удалось создать заявку на оплату. Попробуйте позже.');
      }
    });

    bot.callbackQuery(/^manualpaid:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const paymentId = ctx.match![1];
      const payment = await this.botService.prismaService.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment || payment.status !== PaymentStatus.PENDING) {
        return ctx.editMessageText('Эта заявка уже обработана или не найдена.');
      }

      const { user } = await this.botService.findOrCreateUser(ctx);

      if (payment.userId !== user.id) {
        return ctx.editMessageText('Эта заявка принадлежит другому пользователю.');
      }

      ctx.session.adminData = {
        ...(ctx.session.adminData || {}),
        manualPaymentId: paymentId,
      };

      await ctx.reply(
        '📎 <b>Отправьте чек или скриншот оплаты</b> следующим сообщением.\n\n' +
          'Подойдут фото или файл.',
        { parse_mode: 'HTML' },
      );
    });

    const processPaymentProof = async (ctx: BotContext, proofFileId: string) => {
      const paymentId = ctx.session.adminData?.manualPaymentId;
      if (!paymentId) return;

      const payment = await this.botService.prismaService.payment.findUnique({
        where: { id: paymentId },
        include: { user: true },
      });

      if (!payment || payment.status !== PaymentStatus.PENDING) {
        if (ctx.session.adminData) {
          delete ctx.session.adminData.manualPaymentId;
        }
        await ctx.reply('Заявка уже обработана или не найдена.');
        return;
      }

      if (!ctx.from || payment.user.telegramId !== BigInt(ctx.from.id)) {
        return;
      }

      await this.botService.prismaService.payment.update({
        where: { id: paymentId },
        data: { proofFileId },
      });

      const adminIds = this.getAdminIds();
      const bankName = payment.bank === 'TBANK' ? 'Т-Банк' : 'Сбербанк';
      const username = payment.user.username ? `@${payment.user.username}` : 'без username';
      const fullName = [payment.user.firstName, payment.user.lastName].filter(Boolean).join(' ');

      for (const adminId of adminIds) {
        try {
          if (ctx.chat && ctx.message) {
            await bot.api.forwardMessage(adminId, ctx.chat.id, ctx.message.message_id);
          }

          await bot.api.sendMessage(
            adminId,
            `💰 <b>Новая заявка на оплату</b>\n\n` +
              `Пользователь: <b>${fullName || username}</b>\n` +
              `Username: ${username}\n` +
              `Telegram ID: <code>${payment.user.telegramId.toString()}</code>\n` +
              `Тариф: <b>Стандарт</b>\n` +
              `Сумма: <b>${(payment.amount / 100).toFixed(0)} ₽</b>\n` +
              `Банк: <b>${bankName}</b>\n` +
              `Payment ID: <code>${payment.id}</code>`,
            {
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
            },
          );
        } catch (e) {
          this.logger.warn(`Could not notify admin ${adminId}`, e);
        }
      }

      if (ctx.session.adminData) {
        delete ctx.session.adminData.manualPaymentId;
      }

      await ctx.reply(
        '✅ Чек отправлен на проверку.\n\nПосле подтверждения подписка активируется автоматически.',
      );
    };

    bot.on('message:photo', async (ctx, next) => {
      if (!ctx.session.adminData?.manualPaymentId) return next();

      const photos = ctx.message.photo;
      const fileId = photos[photos.length - 1]?.file_id;

      if (!fileId) {
        return ctx.reply('Не удалось получить изображение. Попробуйте отправить чек ещё раз.');
      }

      await processPaymentProof(ctx, fileId);
    });

    bot.on('message:document', async (ctx, next) => {
      if (!ctx.session.adminData?.manualPaymentId) return next();

      await processPaymentProof(ctx, ctx.message.document.file_id);
    });

    bot.callbackQuery(/^manualapprove:(.+)$/, async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) {
        return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      }

      const paymentId = ctx.match![1];
      await ctx.answerCallbackQuery({ text: 'Подтверждаем...' });

      try {
        const payment = await this.botService.prismaService.payment.findUnique({
          where: { id: paymentId },
          include: { user: true },
        });

        if (!payment) {
          return ctx.editMessageText('Платёж не найден.');
        }

        if (payment.status === PaymentStatus.CANCELLED) {
          return ctx.editMessageText('❌ Эта заявка уже отклонена.');
        }

        await this.payments.approveManualPayment(paymentId, String(ctx.from!.id));

        const sub = await this.botService.getActiveSubscription(payment.userId);
        const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
        const subUrl = sub && appUrl ? `${appUrl}/sub/${sub.subToken}.txt` : '';

        try {
          await bot.api.sendMessage(
            Number(payment.user.telegramId),
            `✅ <b>Оплата подтверждена!</b>\n\n` +
              `Тариф: <b>Стандарт</b>\n` +
              `Срок: <b>30 дней</b>\n\n` +
              (subUrl
                ? `🔗 Ваша subscription-ссылка:\n<code>${subUrl}</code>\n\n`
                : '') +
              `Также ссылка доступна в разделе «📱 Мои устройства».`,
            { parse_mode: 'HTML' },
          );
        } catch (e) {
          this.logger.warn('Could not notify user about approved manual payment', e);
        }

        await ctx.editMessageText(
          `✅ <b>Оплата подтверждена</b>\n\nPayment ID: <code>${paymentId}</code>`,
          { parse_mode: 'HTML' },
        );
      } catch (e) {
        this.logger.error('Approve manual payment error', e);
        await ctx.reply('Ошибка при подтверждении платежа.');
      }
    });

    bot.callbackQuery(/^manualreject:(.+)$/, async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) {
        return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      }

      const paymentId = ctx.match![1];
      await ctx.answerCallbackQuery({ text: 'Отклоняем...' });

      try {
        const payment = await this.botService.prismaService.payment.findUnique({
          where: { id: paymentId },
          include: { user: true },
        });

        if (!payment) {
          return ctx.editMessageText('Платёж не найден.');
        }

        if (payment.status === PaymentStatus.SUCCEEDED) {
          return ctx.editMessageText('✅ Эта заявка уже подтверждена.');
        }

        await this.botService.prismaService.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.CANCELLED,
            reviewedAt: new Date(),
            reviewedBy: String(ctx.from!.id),
          },
        });

        try {
          await bot.api.sendMessage(
            Number(payment.user.telegramId),
            '❌ Оплата не подтверждена.\n\nПроверьте перевод и при необходимости создайте новую заявку.',
          );
        } catch (e) {
          this.logger.warn('Could not notify user about rejected manual payment', e);
        }

        await ctx.editMessageText(
          `❌ <b>Заявка отклонена</b>\n\nPayment ID: <code>${paymentId}</code>`,
          { parse_mode: 'HTML' },
        );
      } catch (e) {
        this.logger.error('Reject manual payment error', e);
        await ctx.reply('Ошибка при отклонении платежа.');
      }
    });

    bot.callbackQuery(/^app:(happ|v2raytun|hiddify|qr|copy)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const app = ctx.match![1];

      const { user } = await this.botService.findOrCreateUser(ctx);
      const sub = await this.botService.getActiveSubscription(user.id);

      if (!sub) {
        return ctx.reply('Нет активной подписки.');
      }

      const appUrl = (this.config.get<string>('APP_URL') || 'https://your-domain.com').replace(
        /\/$/,
        '',
      );
      const subUrl = `${appUrl}/sub/${sub.subToken}.txt`;

      if (app === 'copy' || app === 'qr') {
        return ctx.reply(`🔗 Ваша ссылка:\n<code>${subUrl}</code>`, {
          parse_mode: 'HTML',
        });
      }

      const instructions: Record<string, string> = {
        happ:
          `🍏 <b>Happ</b>\n\n1. Скачайте Happ\n2. Нажмите «+» → «URL подписки»\n3. Вставьте:\n<code>${subUrl}</code>`,
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
