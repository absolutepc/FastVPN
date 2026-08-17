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

  @Get('test/germany/:token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Profile-Update-Interval', '12')
  @Header('Happ-Ping-Type', 'tcp')
  @Header('Happ-Ping-On-Open', 'true')
  async getGermanySmartTest(
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

    const uuid = sub.uuid;

    const main =
      `vless://${uuid}@130.17.24.143:443` +
      `?encryption=none` +
      `&flow=xtls-rprx-vision` +
      `&security=reality` +
      `&sni=www.cloudflare.com` +
      `&fp=chrome` +
      `&pbk=aTv2LVdB1nIybUlvhXGuAY4I6eq-eWATkYIhHo3y9Qo` +
      `&sid=933c83a3` +
      `&type=tcp` +
      `&headerType=none` +
      `#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20MAIN`;

    const xhttp =
      `vless://${uuid}@130.17.24.143:445` +
      `?encryption=none` +
      `&security=reality` +
      `&sni=www.cloudflare.com` +
      `&fp=chrome` +
      `&pbk=aTv2LVdB1nIybUlvhXGuAY4I6eq-eWATkYIhHo3y9Qo` +
      `&sid=933c83a3` +
      `&type=xhttp` +
      `&path=%2F4steps-xhttp` +
      `#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20XHTTP`;

    const ws =
      `vless://${uuid}@130.17.24.143:444` +
      `?encryption=none` +
      `&security=none` +
      `&type=ws` +
      `&host=ws-de1.4stepsvpn.ru` +
      `&path=%2Fws-test` +
      `#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20WS`;

    const fast =
      `hy2://${uuid}@hy-de1.4stepsvpn.ru:443/` +
      `?sni=hy-de1.4stepsvpn.ru` +
      `#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20FAST`;

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="4StepsVPN-Germany-Smart-Test.txt"',
    );

    return [main, xhttp, ws, fast].join('\n') + '\n';
  }

  @Get(':token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Profile-Update-Interval', '12')
  @Header('Happ-Ping-Type', 'tcp')
  @Header('Happ-Ping-On-Open', 'true')
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
