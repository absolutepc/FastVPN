import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { BotModule } from './bot/bot.module';
import { HealthController } from './health.controller';
import { PaymentsModule } from './modules/payments/payments.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { WebappModule } from './modules/webapp/webapp.module';
import { XrayModule } from './modules/xray/xray.module';
import { NodeInstallController } from './node-install.controller';
import { NodeRegisterController } from './node-register.controller';
import { NodeTunnelService } from './node-tunnel.service';
import { PrismaModule } from './prisma/prisma.module';

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
    WebappModule,
    BotModule,
  ],
  providers: [
    NodeTunnelService,
  ],
  controllers: [
    HealthController,
    NodeInstallController,
    NodeRegisterController,
  ],
})
export class AppModule {}
