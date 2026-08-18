import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  Param,
  Res,
  NotFoundException,
  ForbiddenException,
  Header,
} from '@nestjs/common';
import type { Response } from 'express';
import { SubscriptionsService } from './subscriptions.service';

@Controller('sub')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post('hysteria-auth/:token')
  @HttpCode(200)
  async hysteriaAuth(
    @Param('token') token: string,
    @Body()
    body: {
      addr?: string;
      auth?: string;
      tx?: number;
    },
  ) {
    const expectedToken = process.env.HYSTERIA_AUTH_TOKEN ?? '';

    if (
      !expectedToken ||
      !token ||
      token.length !== expectedToken.length ||
      token !== expectedToken
    ) {
      return {
        ok: false,
        id: '',
      };
    }

    const auth = typeof body?.auth === 'string' ? body.auth.trim() : '';

    if (!auth || auth.length > 128) {
      return {
        ok: false,
        id: '',
      };
    }

    const sub = await this.subscriptions.getValidSubscriptionByUuid(auth);

    if (!sub) {
      return {
        ok: false,
        id: '',
      };
    }

    return {
      ok: true,
      id: sub.id,
    };
  }

  @Get(':token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Profile-Update-Interval', '12')
  @Header('Happ-Ping-Type', 'tcp')
  @Header('Happ-Ping-On-Open', 'true')
  @Header('providerid', 'bdYDx08Z')
  @Header('subscription-autoconnect', '1')
  @Header('subscription-autoconnect-type', 'lowestdelay')
  @Header('subscription-ping-onopen-enabled', '1')
  @Header('subscription-auto-update-open-enable', '1')
  @Header('subscriptions-sort-type', 'ping')
  async getSubscription(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!token || token.length < 16) {
      throw new NotFoundException();
    }

    const sub = await this.subscriptions.getValidSubscriptionByToken(token);

    if (!sub) {
      throw new NotFoundException();
    }

    if (sub.user.isBlocked) {
      throw new ForbiddenException();
    }

    const links = await this.subscriptions.buildSubscriptionLinks({
      id: sub.id,
      uuid: sub.uuid,
      plan: sub.plan,
    });

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="4StepsVPN-${sub.plan.toLowerCase()}.txt"`,
    );

    return links.join('\n') + '\n';
  }
}
