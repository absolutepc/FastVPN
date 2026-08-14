import {
  Controller,
  Get,
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

  @Get(':token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Profile-Update-Interval', '12')
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
