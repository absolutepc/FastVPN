import { Body, Controller, Post } from '@nestjs/common';
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

  @Post('payment')
  async payment(@Body() body: { initData?: string; plan?: string }) {
    return this.webapp.createPayment(body.initData || '', body.plan || 'STANDARD');
  }
}
