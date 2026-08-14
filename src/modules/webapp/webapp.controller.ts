import {
  Body,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { WebappService } from './webapp.service';

@Controller('api/webapp')
export class WebappController {
  constructor(private readonly webapp: WebappService) {}

  @Post('me')
  async me(@Body() body: { initData?: string }) {
    return this.webapp.getCabinet(body.initData || '');
  }


  @Post('admin/dashboard')
  async adminDashboard(@Body() body: { initData?: string }) {
    return this.webapp.getAdminDashboard(body.initData || '');
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
