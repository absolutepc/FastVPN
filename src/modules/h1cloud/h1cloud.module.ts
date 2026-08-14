import { Module } from '@nestjs/common';
import { H1CloudService } from './h1cloud.service';

@Module({
  providers: [H1CloudService],
  exports: [H1CloudService],
})
export class H1CloudModule {}
