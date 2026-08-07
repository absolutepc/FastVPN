import { Body, Controller, Post } from '@nestjs/common';
import { WebappService } from './webapp.service';

@Controller('api/webapp')
export class WebappController {
  constructor(private readonly webapp: WebappService) {}

  @Post('me')
  async me(@Body() body: { initData?: string }) {
    return this.webapp.getCabinet(body.initData || '');
  }

  @Post('payment')
  async payment(@Body() body: { initData?: string; plan?: string }) {
    return this.webapp.createPayment(body.initData || '', body.plan || 'STANDARD');
  }
}
