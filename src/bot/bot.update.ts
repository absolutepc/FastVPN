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

  private async claimSubGift(
    token: string,
    userId: string,
  ) {
    const result =
      await this.payments.claimPaidGift(
        token,
        userId,
      );

    const planName =
      result.plan === PlanType.PREMIUM
        ? 'Премиум'
        : 'Стандарт';

    const months =
      Math.max(
        1,
        Math.round(result.days / 30),
      );

    const periodText =
      months === 1
        ? '1 месяц'
        : months >= 2 && months <= 4
          ? `${months} месяца`
          : `${months} месяцев`;

    return {
      result,
      message:
        result.alreadyClaimed
          ? `🎁 <b>Этот подарок уже был активирован.</b>`
          : `🎁 <b>Вам подарили 4StepsVPN!</b>\n\n` +
            `Тариф: <b>${planName}</b>\n` +
            `Срок: <b>${periodText}</b>\n\n` +
            `✅ Подарок активирован.\n` +
            `Нажмите «📱 Мои устройства», чтобы получить ссылку подключения.`,
    };
  }

  onModuleInit() {
    const bot = this.botService.bot;

    bot.command('start', async (ctx) => {
      const payload = ctx.match?.trim() || undefined;

      const subGiftToken =
        payload?.startsWith('subgift_')
          ? payload.slice('subgift_'.length).trim()
          : null;

      if (subGiftToken) {
        ctx.session.pendingSubGiftToken =
          subGiftToken;
      }

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

      if (subGiftToken) {
        try {
          const claimed =
            await this.claimSubGift(
              subGiftToken,
              user.id,
            );

          delete ctx.session.pendingSubGiftToken;

          await ctx.reply(
            claimed.message,
            {
              parse_mode: 'HTML',
            },
          );

          return;
        } catch (error) {
          delete ctx.session.pendingSubGiftToken;

          const code =
            error instanceof Error
              ? error.message
              : String(error);

          const message =
            code === 'GIFT_SELF_CLAIM_FORBIDDEN'
              ? 'Этот подарок предназначен для другого пользователя.'
              : code === 'GIFT_NOT_PAID'
                ? 'Подарок ещё не оплачен.'
                : code === 'GIFT_NOT_FOUND'
                  ? 'Подарочная ссылка недействительна.'
                  : code === 'ACTIVE_SUBSCRIPTION_PLAN_CONFLICT'
                    ? 'У вас уже активна подписка другого тарифа. Обратитесь в поддержку.'
                    : 'Не удалось активировать подарок. Обратитесь в поддержку.';

          await ctx.reply(
            `🎁 <b>${message}</b>`,
            {
              parse_mode: 'HTML',
            },
          );
        }
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

      const pendingSubGiftToken =
        ctx.session.pendingSubGiftToken;

      if (pendingSubGiftToken) {
        try {
          const claimed =
            await this.claimSubGift(
              pendingSubGiftToken,
              user.id,
            );

          delete ctx.session.pendingSubGiftToken;

          await ctx.reply(
            claimed.message,
            {
              parse_mode: 'HTML',
            },
          );

          return;
        } catch (error) {
          delete ctx.session.pendingSubGiftToken;

          const code =
            error instanceof Error
              ? error.message
              : String(error);

          const message =
            code === 'GIFT_SELF_CLAIM_FORBIDDEN'
              ? 'Этот подарок предназначен для другого пользователя.'
              : code === 'GIFT_NOT_PAID'
                ? 'Подарок ещё не оплачен.'
                : code === 'GIFT_NOT_FOUND'
                  ? 'Подарочная ссылка недействительна.'
                  : code === 'ACTIVE_SUBSCRIPTION_PLAN_CONFLICT'
                    ? 'У вас уже активна подписка другого тарифа. Обратитесь в поддержку.'
                    : 'Не удалось активировать подарок. Обратитесь в поддержку.';

          await ctx.reply(
            `🎁 <b>${message}</b>`,
            {
              parse_mode: 'HTML',
            },
          );
        }
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
                web_app: { url: `${appUrl}/?v=85` },
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
              [{ text: '🎁 Подарить подписку', callback_data: 'giftbuy:standard' }],
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
                  web_app: { url: `${appUrl}/?v=85` },
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

    bot.callbackQuery(
      /^giftbuy:(standard|premium)$/,
      async (ctx) => {
        await ctx.answerCallbackQuery();

        const planKey = ctx.match![1];

        if (planKey === 'premium') {
          return ctx.editMessageText(
            '👑 Премиум пока недоступен для подарка.',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎁 Подарить Стандарт',
                      callback_data: 'giftbuy:standard',
                    },
                  ],
                  [
                    {
                      text: '« Назад',
                      callback_data: 'back:main',
                    },
                  ],
                ],
              },
            },
          );
        }

        const { user } =
          await this.botService.findOrCreateUser(ctx);

        if (user.isBlocked) {
          return ctx.editMessageText(
            'Доступ ограничен.',
          );
        }

        await ctx.editMessageText(
          `🎁 <b>Подарить 4StepsVPN</b>\n\n` +
            `Тариф: <b>Стандарт</b>\n\n` +
            `Выберите срок подарка:\n\n` +
            `1 месяц — <b>300 ₽</b>\n` +
            `3 месяца — <b>810 ₽</b> <i>−10%</i>\n` +
            `6 месяцев — <b>1 440 ₽</b> <i>−20%</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '1 мес. · 300 ₽',
                    callback_data:
                      'giftduration:1',
                  },
                  {
                    text: '3 мес. · 810 ₽',
                    callback_data:
                      'giftduration:3',
                  },
                ],
                [
                  {
                    text: '6 мес. · 1 440 ₽',
                    callback_data:
                      'giftduration:6',
                  },
                ],
                [
                  {
                    text: '9 месяцев',
                    callback_data:
                      'giftduration:9',
                  },
                  {
                    text: '12 месяцев',
                    callback_data:
                      'giftduration:12',
                  },
                ],
                [
                  {
                    text: '« Назад',
                    callback_data: 'back:main',
                  },
                ],
              ],
            },
          },
        );
      },
    );

    bot.callbackQuery(
      /^giftduration:(1|3|6|9|12)$/,
      async (ctx) => {
        await ctx.answerCallbackQuery();

        const durationMonths =
          Number(ctx.match![1]);

        const amount =
          this.payments.getPrice(
            PlanType.STANDARD,
            durationMonths,
          );

        const discount =
          this.payments.getDiscountPercent(
            durationMonths,
          );

        const amountRub =
          Math.round(amount / 100);

        await ctx.editMessageText(
          `🎁 <b>Подарок 4StepsVPN</b>\n\n` +
            `Тариф: <b>Стандарт</b>\n` +
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
                      `giftmanualpay:tbank:${durationMonths}`,
                  },
                ],
                [
                  {
                    text: '🟢 Сбербанк',
                    callback_data:
                      `giftmanualpay:sber:${durationMonths}`,
                  },
                ],
                [
                  {
                    text: '« Назад',
                    callback_data:
                      'giftbuy:standard',
                  },
                ],
              ],
            },
          },
        );
      },
    );

    bot.callbackQuery(
      /^giftmanualpay:(tbank|sber):(1|3|6|9|12)$/,
      async (ctx) => {
        await ctx.answerCallbackQuery();

        const bankKey =
          ctx.match![1] as
            | 'tbank'
            | 'sber';

        const durationMonths =
          Number(ctx.match![2]);

        const bank =
          bankKey === 'tbank'
            ? 'TBANK'
            : 'SBER';

        const bankName =
          bankKey === 'tbank'
            ? 'Т-Банк'
            : 'Сбербанк';

        const { user } =
          await this.botService.findOrCreateUser(ctx);

        if (user.isBlocked) {
          return ctx.editMessageText(
            'Доступ ограничен.',
          );
        }

        try {
          const created =
            await this.payments
              .createManualGiftPayment({
                userId: user.id,
                plan: PlanType.STANDARD,
                bank,
                durationMonths,
              });

          const payment =
            created.payment;

          const phone =
            this.config.get<string>(
              'PAYMENT_PHONE',
            ) || '+79626542959';

          const recipient =
            this.config.get<string>(
              'PAYMENT_RECIPIENT',
            ) || 'Тамерлан Д.';

          const amountRub =
            Math.round(
              payment.amount / 100,
            );

          const discount =
            this.payments
              .getDiscountPercent(
                payment.durationMonths,
              );

          await ctx.editMessageText(
            `🎁 <b>Оплата подарка 4StepsVPN</b>\n\n` +
              `Тариф: <b>Стандарт</b>\n` +
              `Срок: <b>${payment.durationMonths} мес.</b>\n` +
              `Скидка: <b>${discount}%</b>\n` +
              `Сумма: <b>${amountRub.toLocaleString('ru-RU')} ₽</b>\n` +
              `Банк: <b>${bankName}</b>\n\n` +
              `Переведите <b>${amountRub.toLocaleString('ru-RU')} ₽</b> по номеру телефона:\n` +
              `<code>${phone}</code>\n` +
              `Получатель: <b>${recipient}</b>\n\n` +
              `После оплаты нажмите «✅ Я оплатил».`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '✅ Я оплатил',
                      callback_data:
                        `manualpaid:${payment.id}`,
                    },
                  ],
                  [
                    {
                      text: '« Назад',
                      callback_data:
                        `giftduration:${payment.durationMonths}`,
                    },
                  ],
                ],
              },
            },
          );
        } catch (e) {
          this.logger.error(
            'Create manual gift payment error',
            e,
          );

          await ctx.editMessageText(
            'Не удалось создать заявку на оплату подарка. Попробуйте позже.',
          );
        }
      },
    );

    bot.on('inline_query', async (ctx) => {
      const query =
        ctx.inlineQuery.query.trim();

      this.logger.log(
        `Inline query received: user=${ctx.from.id} query=${query.slice(0, 80)}`,
      );

      if (!query.startsWith('subgift_')) {
        await ctx.answerInlineQuery(
          [],
          {
            cache_time: 0,
            is_personal: true,
          },
        );
        return;
      }

      const token =
        query.slice('subgift_'.length).trim();

      if (!token) {
        await ctx.answerInlineQuery(
          [],
          {
            cache_time: 0,
            is_personal: true,
          },
        );
        return;
      }

      try {
        const gift =
          await this.botService.prismaService
            .giftSubscription.findUnique({
              where: {
                token,
              },
            });

        this.logger.log(
          gift
            ? `Inline gift found: id=${gift.id} status=${gift.status}`
            : `Inline gift not found for token=${token.slice(0, 12)}...`,
        );

        if (
          !gift ||
          gift.status !== 'PAID' ||
          gift.claimedAt ||
          gift.recipientId
        ) {
          await ctx.answerInlineQuery(
            [],
            {
              cache_time: 0,
              is_personal: true,
            },
          );
          return;
        }

        const planName =
          gift.plan === PlanType.PREMIUM
            ? 'Премиум'
            : 'Стандарт';

        const periodText =
          gift.durationMonths === 1
            ? '1 месяц'
            : gift.durationMonths >= 2 &&
                gift.durationMonths <= 4
              ? `${gift.durationMonths} месяца`
              : `${gift.durationMonths} месяцев`;

        const botInfo =
          await bot.api.getMe();

        const giftLink =
          `https://t.me/${botInfo.username}?start=subgift_${gift.token}`;

        await ctx.answerInlineQuery(
          [
            {
              type: 'article',
              id: gift.id,
              title:
                `🎁 4StepsVPN на ${periodText}`,
              description:
                `${planName} · ${periodText}`,
              input_message_content: {
                message_text:
                  `🎁 <b>Вам подарили 4StepsVPN на ${periodText}!</b>\n\n` +
                  `🛡 Тариф: <b>${planName}</b>\n\n` +
                  `Подарок активируется после получения.\n` +
                  `Срок подписки начнётся с момента активации.`,
                parse_mode: 'HTML',
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎁 Получить подарок',
                      url: giftLink,
                    },
                  ],
                ],
              },
            },
          ],
          {
            cache_time: 0,
            is_personal: true,
          },
        );

        this.logger.log(
          `Inline gift result sent: gift=${gift.id}`,
        );
      } catch (error) {
        this.logger.error(
          'Inline gift query failed',
          error,
        );

        await ctx.answerInlineQuery(
          [],
          {
            cache_time: 0,
            is_personal: true,
          },
        ).catch(() => {});
      }
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

      ctx.session.pendingManualPaymentId =
        paymentId;

      await ctx.reply(
        '📎 <b>Отправьте чек или скриншот оплаты</b> следующим сообщением.\n\n' +
          'Подойдут фото или файл.',
        { parse_mode: 'HTML' },
      );
    });

    const processPaymentProof = async (
      ctx: BotContext,
      proofFileId: string,
    ) => {
      const paymentId =
        ctx.session.pendingManualPaymentId;

      if (!paymentId) return;

      const payment =
        await this.botService.prismaService.payment.findUnique({
          where: {
            id: paymentId,
          },
          include: {
            user: true,
            gift: true,
          },
        });

      if (
        !payment ||
        payment.status !== PaymentStatus.PENDING
      ) {
        delete ctx.session.pendingManualPaymentId;

        await ctx.reply(
          'Заявка уже обработана или не найдена.',
        );
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

      delete ctx.session.pendingManualPaymentId;

      await ctx.reply(
        payment.gift
          ? '✅ Чек отправлен на проверку.\n\nПосле подтверждения вы получите подарочную ссылку для отправки другу.'
          : '✅ Чек отправлен на проверку.\n\nПосле подтверждения подписка активируется автоматически.',
      );
    };

    bot.on('message:photo', async (ctx, next) => {
      if (!ctx.session.pendingManualPaymentId) {
        return next();
      }

      const photos = ctx.message.photo;
      const fileId = photos[photos.length - 1]?.file_id;

      if (!fileId) {
        return ctx.reply('Не удалось получить изображение. Попробуйте отправить чек ещё раз.');
      }

      await processPaymentProof(ctx, fileId);
    });

    bot.on('message:document', async (ctx, next) => {
      if (!ctx.session.pendingManualPaymentId) {
        return next();
      }

      await processPaymentProof(
        ctx,
        ctx.message.document.file_id,
      );
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
          include: {
            user: true,
            gift: true,
          },
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

        /*
         * Для подарка подписку покупателю НЕ ищем.
         * После approve отправляем готовую deep-link ссылку.
         */
        if (
          approval.giftId &&
          approval.giftPaid
        ) {
          const gift =
            await this.botService.prismaService
              .giftSubscription.findUniqueOrThrow({
                where: {
                  id: approval.giftId,
                },
              });

          const botInfo =
            await bot.api.getMe();

          const giftLink =
            `https://t.me/${botInfo.username}?start=subgift_${gift.token}`;

          const planName =
            gift.plan === PlanType.PREMIUM
              ? 'Премиум'
              : 'Стандарт';

          const amountRub =
            Math.round(gift.amount / 100);

          const periodText =
            gift.durationMonths === 1
              ? '1 месяц'
              : gift.durationMonths >= 2 &&
                  gift.durationMonths <= 4
                ? `${gift.durationMonths} месяца`
                : `${gift.durationMonths} месяцев`;

          try {
            await bot.api.sendMessage(
              Number(payment.user.telegramId),
              `🎁 <b>Оплата подарка подтверждена!</b>\n\n` +
                `Тариф: <b>${planName}</b>\n` +
                `Срок: <b>${periodText}</b>\n` +
                `Сумма: <b>${amountRub.toLocaleString('ru-RU')} ₽</b>\n\n` +
                `Нажмите <b>«📤 Отправить подарок»</b> и выберите друга.\n` +
                `В чат будет отправлена готовая карточка с кнопкой «🎁 Получить подарок».`,
              {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '📤 Отправить подарок',
                        switch_inline_query:
                          `subgift_${gift.token}`,
                      },
                    ],
                  ],
                },
              },
            );
          } catch (e) {
            this.logger.warn(
              'Could not notify user about approved gift payment',
              e,
            );
          }

          return ctx.editMessageText(
            `✅ <b>Оплата подарка подтверждена</b>\n\n` +
              `Gift ID: <code>${gift.id}</code>\n` +
              `Payment ID: <code>${paymentId}</code>`,
            {
              parse_mode: 'HTML',
            },
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
          include: {
            user: true,
            gift: true,
          },
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
            payment.gift
              ? '❌ Оплата подарка не подтверждена.\n\nПодарочная заявка отменена. Проверьте перевод и при необходимости создайте новую.'
              : '❌ Оплата не подтверждена.\n\nПроверьте перевод и при необходимости создайте новую заявку.',
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
