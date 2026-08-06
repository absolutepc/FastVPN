import { Module, Global } from '@nestjs/common';
import { XrayService } from './xray.service';

@Global()
@Module({
  providers: [XrayService],
  exports: [XrayService],
})
export class XrayModule {}
