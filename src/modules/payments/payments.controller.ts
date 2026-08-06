import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BotService } from '../../bot/bot.service';
import { ConfigService } from '@nestjs/config';

interface YooKassaNotification {
  type: string;
  event: string;
  object: {
    id: string;
    status: string;
    metadata?: Record<string, string>;
    amount?: { value: string; currency: string };
  };
}

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
    private readonly botService: BotService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /payments/webhook
   * ЮKassa шлёт уведомления сюда.
   * В личном кабинете укажите URL: https://your-domain.com/payments/webhook
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() body: YooKassaNotification) {
    this.logger.log(`Webhook: ${body.event} id=${body.object?.id}`);

    try {
      if (body.event === 'payment.succeeded') {
        const payment = await this.payments.handleSucceeded(
          body.object.id,
          body.object.metadata,
        );

        if (payment) {
          const user = await this.prisma.user.findUnique({
            where: { id: payment.userId },
          });

          if (user) {
            const planName = payment.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';
            const appUrl = this.config.get<string>('APP_URL') || '';

            try {
              await this.botService.bot.api.sendMessage(
                Number(user.telegramId),
                `✅ <b>Оплата прошла успешно!</b>\n\n` +
                  `Тариф: <b>${planName}</b>\n` +
                  `Срок: 30 дней\n\n` +
                  `Откройте «📱 Мои устройства», чтобы получить ссылку.` +
                  (appUrl ? `` : ''),
                { parse_mode: 'HTML' },
              );
            } catch (e) {
              this.logger.warn('Could not notify user about payment', e);
            }
          }
        }
      }

      if (body.event === 'payment.canceled') {
        await this.payments.handleCanceled(body.object.id);
      }
    } catch (e) {
      this.logger.error('Webhook processing error', e);
      // всё равно 200, чтобы ЮKassa не ретраила бесконечно при наших багах
    }

    return { ok: true };
  }
}
