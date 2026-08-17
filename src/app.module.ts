import { NodeTunnelService } from './node-tunnel.service';
import { NodeRegisterController } from './node-register.controller';
import { NodeInstallController } from './node-install.controller';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { BotModule } from './bot/bot.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { XrayModule } from './modules/xray/xray.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebappModule } from './modules/webapp/webapp.module';

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
    NodeInstallController,
    NodeRegisterController,
  ],
})
export class AppModule {}
