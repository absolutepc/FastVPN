import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { BotService, BotContext } from './bot.service';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../modules/payments/payments.service';
import {
  PaymentStatus,
  PlanType,
  UserRole,
} from '@prisma/client';
import QRCode from 'qrcode';
import { InputFile } from 'grammy';

@Injectable()
export class BotUpdate implements OnModuleInit {
  private readonly logger = new Logger(BotUpdate.name);

  constructor(
    private readonly botService: BotService,
    private readonly config: ConfigService,
    private readonly payments: PaymentsService,
  ) {}

  private async isAdmin(
    telegramId: number | undefined,
  ): Promise<boolean> {
    if (!telegramId) return false;

    const user =
      await this.botService.prismaService.user.findUnique({
        where: {
          telegramId: BigInt(telegramId),
        },
        select: {
          role: true,
        },
      });

    if (
      user?.role === UserRole.OWNER ||
      user?.role === UserRole.ADMIN
    ) {
      return true;
    }

    const raw =
      this.config.get<string>('ADMIN_IDS') || '';

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

  private readonly legalVersion = '2026-08-20';

  private readonly termsUrl =
    'https://telegra.ph/PUBLICHNAYA-OFERTA-08-12-15';

  private readonly privacyUrl =
    'https://telegra.ph/POLITIKA-KONFIDENCIALNOSTI-08-12-99';

  private getLegalKeyboard() {
    return {
      inline_keyboard: [
        [
          {
            text: '📄 Пользовательское соглашение',
            url: this.termsUrl,
          },
        ],
        [
          {
            text: '🔒 Политика конфиденциальности',
            url: this.privacyUrl,
          },
        ],
        [
          {
            text: '✅ Согласиться',
            callback_data: 'legal:accept',
          },
        ],
      ],
    };
  }

  onModuleInit() {
    const bot = this.botService.bot;

    bot.command('start', async (ctx) => {
      const payload = ctx.match?.trim() || undefined;

      const {
        user,
        isNew,
        referralProcessed,
        ownerInviteProcessed,
        ownerInviteDays,
      } = await this.botService.findOrCreateUser(
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

      if (ownerInviteProcessed) {
        welcome +=
          `\n\n🎁 Вам активирован <b>подарочный период ${ownerInviteDays} дн.</b> (Стандарт)!\n` +
          `Нажмите «📱 Мои устройства», чтобы получить ссылку.`;
      }

      const legalAccepted =
        user.legalAcceptedAt &&
        user.legalVersion === this.legalVersion;

      if (!legalAccepted) {
        welcome +=
          `\n\nПеред использованием сервиса ознакомьтесь с документами ` +
          `и подтвердите согласие.`;

        await ctx.reply(welcome, {
          parse_mode: 'HTML',
          reply_markup: this.getLegalKeyboard(),
        });

        return;
      }

      welcome += `\n\nВыберите действие:`;

      const adminAccess =
        await this.isAdmin(ctx.from?.id);

      await ctx.reply(welcome, {
        parse_mode: 'HTML',
        reply_markup:
          this.botService.getMainKeyboard(adminAccess),
      });
    });

    bot.callbackQuery('legal:accept', async (ctx) => {
      const telegramId = BigInt(ctx.from.id);

      const user = await this.botService.prismaService.user.findUnique({
        where: {
          telegramId,
        },
      });

      if (!user) {
        await ctx.answerCallbackQuery({
          text: 'Сначала нажмите /start',
          show_alert: true,
        });
        return;
      }

      if (user.isBlocked) {
        await ctx.answerCallbackQuery({
          text: 'Доступ ограничен',
          show_alert: true,
        });
        return;
      }

      const alreadyAccepted =
        user.legalAcceptedAt &&
        user.legalVersion === this.legalVersion;

      if (!alreadyAccepted) {
        await this.botService.prismaService.user.update({
          where: {
            id: user.id,
          },
          data: {
            legalAcceptedAt: new Date(),
            legalVersion: this.legalVersion,
          },
        });
      }

      await ctx.answerCallbackQuery({
        text: alreadyAccepted
          ? 'Условия уже приняты'
          : 'Спасибо! Согласие сохранено',
      });

      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: {
            inline_keyboard: [],
          },
        });
      } catch {
        // Сообщение могло быть изменено или устареть.
      }

      const adminAccess =
        await this.isAdmin(ctx.from?.id);

      await ctx.reply(
        '✅ Условия приняты. Теперь вам доступны все функции 4StepsVPN.',
        {
          reply_markup:
            this.botService.getMainKeyboard(adminAccess),
        },
      );
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
          `💰 от <b>300 ₽</b>\n` +
          `📱 2 устройства\n` +
          `🖥 Серверы тарифа Стандарт\n\n` +
          `Чем больше срок — тем выше скидка.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Выбрать срок подписки', callback_data: 'buy:standard' }],
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
      const devices = await this.botService.prismaService.device.findMany({
        where: {
          subscriptionId: sub.id,
          isActive: true,
        },
        orderBy: { slot: 'asc' },
      });
      const deviceLinks = devices
        .map(
          (device) =>
            `📱 <b>${device.name}</b>${
              device.vpnSyncPending ? ' · синхронизация' : ''
            }\n<code>${appUrl}/sub/${device.subToken}.txt</code>`,
        )
        .join('\n\n');
      const linksText =
        deviceLinks ||
        `📱 <b>Основное устройство</b>\n<code>${appUrl}/sub/${sub.subToken}.txt</code>`;
      const expires = sub.expiresAt.toLocaleDateString('ru-RU');
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';
      const trialMark = sub.isTrial ? ' (пробный)' : '';

      await ctx.reply(
        `📱 <b>Ваша подписка</b>\n\n` +
          `Тариф: <b>${planName}</b>${trialMark}\n` +
          `Действует до: <b>${expires}</b>\n\n` +
          `${linksText}\n\n` +
          `👇 Выберите приложение`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟣 INCY', callback_data: 'app:incy' },
                { text: '🍏 Happ', callback_data: 'app:happ' },
              ],
              [
                { text: '📱 v2RayTun', callback_data: 'app:v2raytun' },
                { text: '🤖 Hiddify', callback_data: 'app:hiddify' },
              ],
              [
                { text: '📷 QR', callback_data: 'app:qr' },
                { text: '📋 Скопировать ссылку', callback_data: 'app:copy' },
              ],
              [
                {
                  text: '⚙️ Управлять устройствами',
                  web_app: { url: `${appUrl}/` },
                },
              ],
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
          `Выберите срок продления.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Выбрать срок', callback_data: 'buy:standard' }],
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

      const qrBuffer = await QRCode.toBuffer(link, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 640,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });

      await ctx.replyWithPhoto(
        new InputFile(qrBuffer, '4stepsvpn-referral.png'),
        {
          caption:
            `👥 <b>Пригласи друга</b>\n\n` +
            `Покажи другу этот QR-код или отправь ссылку:\n` +
            `<code>${link}</code>\n\n` +
            `Что получите:\n` +
            `• Друг — 7 дней <b>Стандарт</b> бесплатно\n` +
            `• Ты — +7 дней к своей подписке (только Стандарт)`,
          parse_mode: 'HTML',
        },
      );
    });

    bot.hears('💬 Поддержка', async (ctx) => {
      await ctx.reply(
        'Напишите ваш вопрос — мы ответим как можно скорее.\n\nПоддержка: @dakaev21',
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
          'Выберите срок подписки:\n\n' +
          '1 месяц — <b>300 ₽</b>\n' +
          '3 месяца — <b>810 ₽</b> <i>−10%</i>\n' +
          '6 месяцев — <b>1 440 ₽</b> <i>−20%</i>',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '1 мес. · 300 ₽', callback_data: 'buyduration:1' },
                { text: '3 мес. · 810 ₽', callback_data: 'buyduration:3' },
              ],
              [
                { text: '6 мес. · 1 440 ₽', callback_data: 'buyduration:6' },
              ],
              [{ text: '« Назад', callback_data: 'back:main' }],
            ],
          },
        },
      );
    });

    bot.callbackQuery(
      /^buyduration:(1|3|6|9|12)$/,
      async (ctx) => {
        await ctx.answerCallbackQuery();

        const durationMonths = Number(ctx.match![1]);
        const amount =
          this.payments.getPrice(
            PlanType.STANDARD,
            durationMonths,
          );

        const discount =
          this.payments.getDiscountPercent(
            durationMonths,
          );

        const amountRub = Math.round(amount / 100);

        await ctx.editMessageText(
          `🛡 <b>4StepsVPN — Стандарт</b>\n\n` +
            `Срок: <b>${durationMonths} мес.</b>\n` +
            `Скидка: <b>${discount}%</b>\n` +
            `К оплате: <b>${amountRub.toLocaleString('ru-RU')} ₽</b>\n\n` +
            `Выберите банк для оплаты:`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🟡 Т-Банк',
                    callback_data:
                      `manualpay:tbank:${durationMonths}`,
                  },
                ],
                [
                  {
                    text: '🟢 Сбербанк',
                    callback_data:
                      `manualpay:sber:${durationMonths}`,
                  },
                ],
                [
                  {
                    text: '« Назад',
                    callback_data: 'buy:standard',
                  },
                ],
              ],
            },
          },
        );
      },
    );

    bot.callbackQuery(/^manualpay:(tbank|sber):(1|3|6|9|12)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const bankKey = ctx.match![1] as 'tbank' | 'sber';
      const durationMonths = Number(ctx.match![2]);
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
          durationMonths,
        });

        const phone = this.config.get<string>('PAYMENT_PHONE') || '+79626542959';
        const recipient = this.config.get<string>('PAYMENT_RECIPIENT') || 'Тамерлан Д.';

        const amountRub =
          Math.round(payment.amount / 100);

        const discount =
          this.payments.getDiscountPercent(
            payment.durationMonths,
          );

        await ctx.editMessageText(
          `💳 <b>Оплата 4StepsVPN</b>\n\n` +
            `Тариф: <b>Стандарт</b>\n` +
            `Срок: <b>${payment.durationMonths} мес.</b>\n` +
            `Скидка: <b>${discount}%</b>\n` +
            `Сумма: <b>${amountRub.toLocaleString('ru-RU')} ₽</b>\n` +
            `Банк: <b>${bankName}</b>\n\n` +
            `Переведите <b>${amountRub.toLocaleString('ru-RU')} ₽</b> по номеру телефона:\n` +
            `<code>${phone}</code>\n` +
            `Получатель: <b>${recipient}</b>\n\n` +
            `⚠️ Перед переводом убедитесь, что выбран <b>${bankName}</b> и получатель совпадает.\n\n` +
            `После оплаты нажмите «✅ Я оплатил».`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Я оплатил', callback_data: `manualpaid:${payment.id}` }],
                [{
                  text: '« Назад',
                  callback_data:
                    `buyduration:${payment.durationMonths}`,
                }],
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
              `Срок: <b>${payment.durationMonths} мес.</b>\n` +
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
      if (!(await this.isAdmin(ctx.from?.id))) {
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

        const approval =
          await this.payments.approveManualPayment(
            paymentId,
            String(ctx.from!.id),
          );

        if (!approval.applied) {
          return ctx.editMessageText(
            '✅ Эта заявка уже была подтверждена.',
          );
        }

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
      if (!(await this.isAdmin(ctx.from?.id))) {
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

        const rejection =
          await this.payments.rejectManualPayment(
            paymentId,
            String(ctx.from!.id),
          );

        if (!rejection.rejected) {
          if (
            rejection.payment.status ===
            PaymentStatus.SUCCEEDED
          ) {
            return ctx.editMessageText(
              '✅ Эта заявка уже подтверждена.',
            );
          }

          return ctx.editMessageText(
            '❌ Эта заявка уже была обработана.',
          );
        }

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

    bot.callbackQuery(/^app:(incy|happ|v2raytun|hiddify|qr|copy)$/, async (ctx) => {
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

      if (app === 'copy') {
        return ctx.reply(`🔗 Ваша ссылка:\n<code>${subUrl}</code>`, {
          parse_mode: 'HTML',
        });
      }

      if (app === 'incy') {
        return ctx.reply(
          `🟣 <b>INCY</b>\n\n` +
            `1. Откройте INCY\n` +
            `2. Добавьте новую подписку по URL\n` +
            `3. Вставьте ссылку ниже:\n\n` +
            `<code>${subUrl}</code>\n\n` +
            `После добавления обновите подписку в приложении.`,
          {
            parse_mode: 'HTML',
          },
        );
      }

      if (app === 'qr') {
        const qr = await QRCode.toBuffer(subUrl, {
          type: 'png',
          width: 700,
          margin: 2,
          errorCorrectionLevel: 'M',
        });

        return ctx.replyWithPhoto(
          new InputFile(qr, '4stepsvpn-subscription.png'),
          {
            caption:
              '📷 QR-код подписки\n\n' +
              'Отсканируйте его в поддерживаемом VPN-клиенте.\n\n' +
              'Если QR не импортируется — используйте кнопку «📋 Скопировать ссылку».',
          },
        );
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
