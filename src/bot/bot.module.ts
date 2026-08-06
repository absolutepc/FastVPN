import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';

@Module({
  providers: [BotService, BotUpdate],
  exports: [BotService],
})
export class BotModule {}
