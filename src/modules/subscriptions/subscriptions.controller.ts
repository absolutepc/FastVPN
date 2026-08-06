import {
  Controller,
  Get,
  Param,
  Res,
  NotFoundException,
  ForbiddenException,
  Header,
} from '@nestjs/common';
import { Response } from 'express';
import { SubscriptionsService } from './subscriptions.service';

@Controller('sub')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  /**
   * GET /sub/:token
   * Клиенты (Hiddify, v2RayTun, Happ) запрашивают этот URL.
   * Ответ: plain text со списком vless:// ссылок (по одной на строку).
   * Многие клиенты также принимают base64 — отдаём plain для простоты,
   * при необходимости можно переключить.
   */
  @Get(':token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Profile-Update-Interval', '12') // часы, подсказка клиенту
  async getSubscription(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!token || token.length < 16) {
      throw new NotFoundException();
    }

    const sub = await this.subscriptions.getValidSubscriptionByToken(token);

    if (!sub) {
      // Не светим, есть ли токен — просто 404
      throw new NotFoundException();
    }

    if (sub.user.isBlocked) {
      throw new ForbiddenException();
    }

    const links = await this.subscriptions.buildSubscriptionLinks({
      uuid: sub.uuid,
      plan: sub.plan,
    });

    // Имя профиля в клиенте
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="AccessOne-${sub.plan.toLowerCase()}.txt"`,
    );

    return links.join('\n');
  }
}
