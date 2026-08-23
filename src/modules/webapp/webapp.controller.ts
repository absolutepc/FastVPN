import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { WebappService } from './webapp.service';

@Controller('api/webapp')
export class WebappController {
  constructor(private readonly webapp: WebappService) {}

  @Post('me')
  async me(@Body() body: { initData?: string }) {
    return this.webapp.getCabinet(body.initData || '');
  }

  @Post('network-status')
  async networkStatus(
    @Body() body: { initData?: string },
  ) {
    return this.webapp.getNetworkStatus(
      body.initData || '',
    );
  }


  @Get('avatar-file/:fileName')
  async avatarFile(
    @Param('fileName') fileName: string,
    @Res() res: Response,
  ) {
    return this.webapp.sendAvatarFile(
      fileName,
      res,
    );
  }


  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('avatar', {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async uploadAvatar(
    @Body() body: { initData?: string },
    @UploadedFile()
    file?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    return this.webapp.uploadAvatar(
      body?.initData || '',
      file,
    );
  }


  @Post('notifications')
  async notifications(@Body() body: { initData?: string }) {
    return this.webapp.getNotifications(body.initData || '');
  }

  @Post('notifications/:id/read')
  async markNotificationRead(
    @Param('id') id: string,
    @Body() body: { initData?: string },
  ) {
    return this.webapp.markNotificationRead(
      body.initData || '',
      id,
    );
  }

  @Post('admin/dashboard')
  async adminDashboard(@Body() body: { initData?: string }) {
    return this.webapp.getAdminDashboard(body.initData || '');
  }

  @Post('admin/notifications')
  async createAdminNotification(
    @Body()
    body: {
      initData?: string;
      title?: string;
      body?: string;
    },
  ) {
    return this.webapp.createAdminNotification(
      body.initData || '',
      body.title || '',
      body.body || '',
    );
  }

  @Get('support-file/:fileName')
  async supportFile(
    @Param('fileName') fileName: string,
    @Res() res: Response,
  ) {
    return this.webapp.sendSupportFile(
      fileName,
      res,
    );
  }


  @Post('support/tickets')
  @UseInterceptors(
    FileInterceptor('attachment', {
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async createSupportTicket(
    @Body()
    body: {
      initData?: string;
      title?: string;
      body?: string;
    },
    @UploadedFile()
    file?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    return this.webapp.createSupportTicket(
      body.initData || '',
      body.title || '',
      body.body || '',
      file,
    );
  }


  @Post('support/tickets/me')
  async mySupportTickets(
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.getMySupportTickets(
      body.initData || '',
    );
  }


  @Post('support/tickets/:id/reply')
  async replySupportTicket(
    @Param('id') id: string,
    @Body()
    body: {
      initData?: string;
      body?: string;
    },
  ) {
    return this.webapp.replySupportTicket(
      body.initData || '',
      id,
      body.body || '',
    );
  }


  @Post('bonuses')
  async bonuses(
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.getBonuses(
      body.initData || '',
    );
  }


  @Post('bonuses/telegram/claim')
  async claimTelegramBonus(
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.claimTelegramChannelBonus(
      body.initData || '',
    );
  }


  @Post('promo/redeem')
  async redeemPromoCode(
    @Body()
    body: {
      initData?: string;
      code?: string;
    },
  ) {
    return this.webapp.redeemPromoCode(
      body.initData || '',
      body.code || '',
    );
  }


  @Post('admin/promo/:id/redemptions')
  async adminPromoRedemptions(
    @Param('id') id: string,
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.getAdminPromoRedemptions(
      body.initData || '',
      id,
    );
  }


  @Post('admin/promo/:id/delete')
  async adminDeletePromoCode(
    @Param('id') id: string,
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.adminDeletePromoCode(
      body.initData || '',
      id,
    );
  }


  @Post('admin/promo/:id/active')
  async adminSetPromoActive(
    @Param('id') id: string,
    @Body()
    body: {
      initData?: string;
      isActive?: boolean;
    },
  ) {
    return this.webapp.adminSetPromoActive(
      body.initData || '',
      id,
      body.isActive === true,
    );
  }


  @Post('admin/promo/list')
  async adminPromoCodes(
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.getAdminPromoCodes(
      body.initData || '',
    );
  }


  @Post('admin/promo/create')
  async adminCreatePromoCode(
    @Body()
    body: {
      initData?: string;
      code?: string;
      plan?: string;
      days?: number;
      maxUses?: number | null;
      perUserLimit?: number;
      validUntil?: string | null;
      isActive?: boolean;
    },
  ) {
    return this.webapp.adminCreatePromoCode(
      body.initData || '',
      {
        code: body.code,
        plan: body.plan,
        days: body.days,
        maxUses: body.maxUses,
        perUserLimit: body.perUserLimit,
        validUntil: body.validUntil,
        isActive: body.isActive,
      },
    );
  }


  @Post('admin/support/tickets')
  async adminSupportTickets(
    @Body()
    body: {
      initData?: string;
    },
  ) {
    return this.webapp.getAdminSupportTickets(
      body.initData || '',
    );
  }


  @Post('admin/support/tickets/:id/reply')
  async adminReplySupportTicket(
    @Param('id') id: string,
    @Body()
    body: {
      initData?: string;
      body?: string;
    },
  ) {
    return this.webapp.adminReplySupportTicket(
      body.initData || '',
      id,
      body.body || '',
    );
  }


  @Post('admin/support/tickets/:id/status')
  async updateSupportTicketStatus(
    @Param('id') id: string,
    @Body()
    body: {
      initData?: string;
      status?: string;
    },
  ) {
    return this.webapp.updateSupportTicketStatus(
      body.initData || '',
      id,
      body.status || '',
    );
  }


  @Post('device/activate')
  async activateDevice(
    @Body() body: { initData?: string; name?: string; platform?: string },
  ) {
    return this.webapp.activateDevice(
      body.initData || '',
      body.name,
      body.platform,
    );
  }

  @Post('manual-payment')
  async createManualPayment(
    @Body()
    body: {
      initData?: string;
      plan?: string;
      bank?: string;
    },
  ) {
    return this.webapp.createManualWebappPayment(
      body.initData || '',
      body.plan || 'STANDARD',
      body.bank || '',
    );
  }

  @Post('manual-payment/:paymentId/proof')
  @UseInterceptors(
    FileInterceptor('proof', {
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
      },
    }),
  )
  async submitManualPaymentProof(
    @Param('paymentId') paymentId: string,
    @Body() body: { initData?: string },
    @UploadedFile()
    file?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    return this.webapp.submitManualWebappProof(
      body.initData || '',
      paymentId,
      file,
    );
  }

  @Post('payment')
  async payment(@Body() body: { initData?: string; plan?: string }) {
    return this.webapp.createPayment(
      body.initData || '',
      body.plan || 'STANDARD',
    );
  }
}
