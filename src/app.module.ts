import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { BotModule } from './bot/bot.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { XrayModule } from './modules/xray/xray.module';
import { PaymentsModule } from './modules/payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    XrayModule,
    SubscriptionsModule,
    PaymentsModule,
    BotModule,
  ],
})
export class AppModule {}
