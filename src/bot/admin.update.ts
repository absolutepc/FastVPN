import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotService, BotContext } from './bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { execFile } from 'child_process';
import { SubscriptionsService } from '../modules/subscriptions/subscriptions.service';
import { XrayService } from '../modules/xray/xray.service';
import { PlanType, SubscriptionStatus, NodeType } from '@prisma/client';

@Injectable()
export class AdminUpdate implements OnModuleInit {
  private async getNodeMetrics(host: string): Promise<any | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/ssh',
      [
        '-i',
        '/root/.ssh/4stepsvpn_xray',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'StrictHostKeyChecking=yes',
        `root@${host}`,
        '4steps-node-metrics',
      ],
      {
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          this.logger.warn(`Metrics unavailable for ${host}: ${error.message}`);
          return resolve(null);
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          this.logger.warn(`Invalid metrics JSON from ${host}`);
          resolve(null);
        }
      },
    );
  });
}

private formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

private resourceIcon(value: number): string {
  if (value >= 85) return '🔴';
  if (value >= 70) return '🟡';
  return '🟢';
}

private countryFlag(name: string): string {
  const n = name.toLowerCase();

  if (n.includes('germany')) return '🇩🇪';
  if (n.includes('netherlands')) return '🇳🇱';
  if (n.includes('finland')) return '🇫🇮';
  if (n.includes('france')) return '🇫🇷';
  if (n.includes('sweden')) return '🇸🇪';
  if (n.includes('usa') || n.includes('united states')) return '🇺🇸';

  return '🌐';
}
  private readonly logger = new Logger(AdminUpdate.name);
  private adminIds: Set<string>;

  constructor(
    private readonly botService: BotService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly xray: XrayService,
    private readonly config: ConfigService,
  ) {
    const raw = this.config.get<string>('ADMIN_IDS') || '';
    this.adminIds = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }

  private isAdmin(telegramId: number | undefined): boolean {
    if (!telegramId) return false;
    return this.adminIds.has(String(telegramId));
  }

  private adminKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '📊 Dashboard', callback_data: 'admin:dashboard' },
          { text: '🛠 Управление', callback_data: 'admin:manage' },
        ],
        [{ text: '📡 Мониторинг', callback_data: 'admin:monitor' }],
      ],
    };
  }

  private manageKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '➕ Добавить сервер', callback_data: 'admin:add_node' },
          { text: '➖ Удалить сервер', callback_data: 'admin:del_node' },
        ],
        [
          { text: '🎟 Создать промокод', callback_data: 'admin:promo' },
          { text: '📅 Начислить дни', callback_data: 'admin:add_days' },
        ],
        [
          { text: '📢 Рассылка', callback_data: 'admin:broadcast' },
          { text: '🚫 Заблокировать', callback_data: 'admin:block' },
        ],
        [{ text: '✅ Разблокировать', callback_data: 'admin:unblock' }],
        [{ text: '« Назад', callback_data: 'admin:menu' }],
      ],
    };
  }

  onModuleInit() {
    const bot = this.botService.bot;

    bot.command('admin', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.reply('Нет доступа.');
      this.botService.clearAdminSession(ctx);
      await ctx.reply('🔐 <b>Панель администратора</b>', {
        parse_mode: 'HTML',
        reply_markup: this.adminKeyboard(),
      });
    });

    bot.callbackQuery('admin:menu', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      this.botService.clearAdminSession(ctx);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText('🔐 <b>Панель администратора</b>', {
        parse_mode: 'HTML',
        reply_markup: this.adminKeyboard(),
      });
    });

    bot.callbackQuery('admin:dashboard', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();

      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const [usersCount, activeSubs, trialSubs, revenue, expiringToday, nodesCount] =
        await Promise.all([
          this.prisma.user.count(),
          this.prisma.subscription.count({
            where: {
              status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
              expiresAt: { gt: now },
            },
          }),
          this.prisma.subscription.count({
            where: { status: SubscriptionStatus.TRIAL, expiresAt: { gt: now } },
          }),
          this.prisma.payment.aggregate({
            where: { status: 'SUCCEEDED' },
            _sum: { amount: true },
          }),
          this.prisma.subscription.count({
            where: {
              status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
              expiresAt: { gte: startOfDay, lte: endOfDay },
            },
          }),
          this.prisma.node.count({ where: { isActive: true } }),
        ]);

      const revenueRub = ((revenue._sum.amount || 0) / 100).toFixed(0);

      await ctx.editMessageText(
        `📊 <b>Dashboard</b>\n\n` +
          `👥 Пользователей: <b>${usersCount}</b>\n` +
          `✅ Активных подписок: <b>${activeSubs}</b>\n` +
          `🎁 Trial: <b>${trialSubs}</b>\n` +
          `🖥 Активных серверов: <b>${nodesCount}</b>\n` +
          `💰 Доход (всего): <b>${revenueRub} ₽</b>\n` +
          `⏰ Истекают сегодня: <b>${expiringToday}</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Назад', callback_data: 'admin:menu' }]],
          },
        },
      );
    });

    bot.callbackQuery('admin:manage', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      this.botService.clearAdminSession(ctx);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText('🛠 <b>Управление</b>', {
        parse_mode: 'HTML',
        reply_markup: this.manageKeyboard(),
      });
    });

    bot.callbackQuery('admin:add_days', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      ctx.session.adminAction = 'add_days';
      ctx.session.adminStep = 1;
      ctx.session.adminData = {};
      await ctx.editMessageText(
        '📅 <b>Начислить дни</b>\n\nОтправьте <code>telegram_id</code> пользователя:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Отмена', callback_data: 'admin:manage' }]],
          },
        },
      );
    });

    bot.callbackQuery('admin:block', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      ctx.session.adminAction = 'block';
      ctx.session.adminStep = 1;
      await ctx.editMessageText(
        '🚫 <b>Заблокировать</b>\n\nОтправьте <code>telegram_id</code>:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Отмена', callback_data: 'admin:manage' }]],
          },
        },
      );
    });

    bot.callbackQuery('admin:unblock', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      ctx.session.adminAction = 'unblock';
      ctx.session.adminStep = 1;
      await ctx.editMessageText(
        '✅ <b>Разблокировать</b>\n\nОтправьте <code>telegram_id</code>:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Отмена', callback_data: 'admin:manage' }]],
          },
        },
      );
    });

    bot.callbackQuery('admin:promo', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      ctx.session.adminAction = 'promo';
      ctx.session.adminStep = 1;
      ctx.session.adminData = {};
      await ctx.editMessageText(
        '🎟 <b>Создать промокод</b>\n\n' +
          'Формат: <code>CODE скидка% макс_использований</code>\n' +
          'Пример: <code>SALE20 20 100</code>',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Отмена', callback_data: 'admin:manage' }]],
          },
        },
      );
    });

    bot.callbackQuery('admin:broadcast', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      ctx.session.adminAction = 'broadcast';
      ctx.session.adminStep = 1;
      await ctx.editMessageText('📢 <b>Рассылка</b>\n\nОтправьте текст (HTML):', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '« Отмена', callback_data: 'admin:manage' }]],
        },
      });
    });

    bot.callbackQuery('admin:add_node', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();
      ctx.session.adminAction = 'add_node';
      ctx.session.adminStep = 1;
      ctx.session.adminData = {};
      await ctx.editMessageText(
        '➕ <b>Добавить сервер</b>\n\n' +
          '<code>name|host|port|type|publicKey|shortId|sni</code>\n\n' +
          'Пример:\n<code>NL-1|1.2.3.4|443|standard|pbk|sid|www.cloudflare.com</code>',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Отмена', callback_data: 'admin:manage' }]],
          },
        },
      );
    });

    bot.callbackQuery('admin:del_node', async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      await ctx.answerCallbackQuery();

      const nodes = await this.prisma.node.findMany({ orderBy: { createdAt: 'desc' } });
      if (nodes.length === 0) {
        return ctx.editMessageText('Нет серверов.', {
          reply_markup: {
            inline_keyboard: [[{ text: '« Назад', callback_data: 'admin:manage' }]],
          },
        });
      }

      const buttons = nodes.map((n) => [
        {
          text: `${n.isActive ? '🟢' : '🔴'} ${n.name} (${n.type})`,
          callback_data: `admin:del_node:${n.id}`,
        },
      ]);
      buttons.push([{ text: '« Назад', callback_data: 'admin:manage' }]);

      await ctx.editMessageText('➖ Выберите сервер:', {
        reply_markup: { inline_keyboard: buttons },
      });
    });

    bot.callbackQuery(/^admin:del_node:(.+)$/, async (ctx) => {
      if (!this.isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery({ text: 'Нет доступа' });
      const nodeId = ctx.match![1];
      await ctx.answerCallbackQuery();

      const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
      if (!node) {
        return ctx.editMessageText('Сервер не найден.', {
          reply_markup: {
            inline_keyboard: [[{ text: '« Назад', callback_data: 'admin:manage' }]],
          },
        });
      }

      await this.prisma.node.delete({ where: { id: nodeId } });
      await ctx.editMessageText(`✅ Сервер <b>${node.name}</b> удалён.`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '« Назад', callback_data: 'admin:manage' }]],
        },
      });
    });

    bot.callbackQuery('admin:monitor', async (ctx) => {
  if (!this.isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery({ text: 'Нет доступа' });
  }

  await ctx.answerCallbackQuery({
    text: 'Получаю данные серверов...',
  });

  const nodes = await this.prisma.node.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });

  if (nodes.length === 0) {
    return ctx.editMessageText('Нет активных серверов.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '« Назад', callback_data: 'admin:menu' }],
        ],
      },
    });
  }

  const blocks: string[] = [];

  for (const node of nodes) {
    const metrics = await this.getNodeMetrics(node.host);
    const apiAlive = await this.xray.pingNode(node);

    const users = await this.xray.countUsersOnNodeType(node.type);

    const flag = this.countryFlag(node.name);

    if (!metrics) {
      blocks.push(
        `${flag} <b>${node.name}</b>\n` +
        `🔴 <b>NODE OFFLINE / METRICS UNAVAILABLE</b>\n\n` +
        `🌐 ${node.host}:${node.port}\n` +
        `Xray API: ${apiAlive ? '🟢 OK' : '🔴 FAIL'}\n` +
        `👥 Users: ${users} / ${node.maxUsers ?? '∞'}`,
      );

      continue;
    }

    const cpu = Number(metrics.cpu_percent ?? 0);
    const ram = Number(metrics.ram?.percent ?? 0);
    const disk = Number(metrics.disk?.percent ?? 0);

    const xrayOk = metrics.xray === 'active';
    const portOk = metrics.port_443 === 'open';

    const healthy =
      apiAlive &&
      xrayOk &&
      portOk &&
      cpu < 85 &&
      ram < 85 &&
      disk < 85;

    blocks.push(
      `${flag} <b>${node.name}</b>\n` +
      `${healthy ? '🟢 ONLINE' : '🟡 ATTENTION'}\n\n` +

      `${this.resourceIcon(cpu)} CPU: <b>${cpu.toFixed(1)}%</b>\n` +
      `${this.resourceIcon(ram)} RAM: <b>${metrics.ram.used_mb} / ${metrics.ram.total_mb} MB (${ram.toFixed(1)}%)</b>\n` +
      `${this.resourceIcon(disk)} Disk: <b>${metrics.disk.used} / ${metrics.disk.total} (${disk.toFixed(0)}%)</b>\n` +
      `⚙️ Load: <b>${metrics.load_1m}</b>\n` +
      `⏱ Uptime: <b>${metrics.uptime}</b>\n\n` +

      `Xray: ${xrayOk ? '🟢 active' : '🔴 down'}\n` +
      `Port 443: ${portOk ? '🟢 open' : '🔴 closed'}\n` +
      `Xray API: ${apiAlive ? '🟢 OK' : '🔴 FAIL'}\n` +
      `🔌 Connections: <b>${metrics.connections_443}</b>\n` +
      `👥 Users: <b>${users} / ${node.maxUsers ?? '∞'}</b>\n\n` +

      `📊 <b>Traffic since boot</b>\n` +
      `↓ ${this.formatBytes(Number(metrics.network?.rx_bytes ?? 0))}\n` +
      `↑ ${this.formatBytes(Number(metrics.network?.tx_bytes ?? 0))}`,
    );
  }

  try {
    const h1Nodes =
      await this.subscriptions.getH1CloudMonitoringStatuses();

    for (const h1 of h1Nodes) {
      const synchronized = h1.clients === h1.expected;
      const healthy = h1.apiOk && synchronized;

      const inboundProtocol = h1.inbound
        ? [
            h1.inbound.protocol,
            h1.inbound.security,
            h1.inbound.network,
          ]
            .filter(Boolean)
            .map((value) => String(value).toUpperCase())
            .join(' · ')
        : '—';

      const nearestDays = h1.nearestExpiry
        ? Math.max(
            0,
            Math.ceil(
              (new Date(h1.nearestExpiry).getTime() - Date.now()) /
                86400000,
            ),
          )
        : null;

      blocks.push(
        `<b>${h1.name}</b>\n` +
          `${healthy ? '🟢 ONLINE' : '🟡 ATTENTION'}\n\n` +
          `H1Cloud API: ${h1.apiOk ? '🟢 OK' : '🔴 FAIL'} · ${h1.latencyMs} ms\n` +
          `Inbound: ${h1.inbound?.enabled ? '🟢' : '🔴'} ${inboundProtocol}\n` +
          `Port: <b>${h1.inbound?.port ?? '—'}</b>\n` +
          `👥 Clients: <b>${h1.clients} / ${h1.expected}</b> · active ${h1.active}\n` +
          `⏳ Expired: ${h1.expired} · banned ${h1.banned}\n` +
          `📱 Online: <b>${h1.online}</b> · devices ${h1.devices} / ${h1.deviceLimit}\n` +
          `📊 Traffic: <b>${this.formatBytes(h1.trafficBytes)}</b>\n` +
          `🗓 Nearest expiry: ${nearestDays === null ? '—' : `${nearestDays} day(s)`}\n` +
          `⚙️ ${String(h1.transportMode || '—').toUpperCase()} · ${h1.egressMode || '—'} · Reality ${h1.realityEnabled ? 'ON' : 'OFF'}\n` +
          `🔄 Sync: ${synchronized ? '🟢 OK' : '🟡 MISMATCH'}`,
      );
    }

  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    this.logger.warn(
      `H1Cloud monitoring unavailable: ${message}`,
    );

    blocks.push(
      `🌐 <b>H1Cloud</b>\n` +
        `🔴 <b>MONITORING UNAVAILABLE</b>`,
    );
  }

  await ctx.editMessageText(
    `📡 <b>4StepsVPN · Monitoring</b>\n\n${blocks.join('\n\n──────────────\n\n')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🔄 Обновить',
              callback_data: 'admin:monitor',
            },
          ],
          [
            {
              text: '« Назад',
              callback_data: 'admin:menu',
            },
          ],
        ],
      },
    },
  );
});

    bot.on('message:text', async (ctx, next) => {
      if (!this.isAdmin(ctx.from?.id)) return next();
      if (!ctx.session.adminAction) return next();

      const text = ctx.message.text.trim();
      const action = ctx.session.adminAction;
      const step = ctx.session.adminStep || 1;

      try {
        if (action === 'add_days') {
          await this.handleAddDays(ctx, text, step);
          return;
        }
        if (action === 'block' || action === 'unblock') {
          await this.handleBlock(ctx, text, action === 'block');
          return;
        }
        if (action === 'promo') {
          await this.handlePromo(ctx, text);
          return;
        }
        if (action === 'broadcast') {
          await this.handleBroadcast(ctx, text);
          return;
        }
        if (action === 'add_node') {
          await this.handleAddNode(ctx, text);
          return;
        }
      } catch (e) {
        this.logger.error('Admin action error', e);
        await ctx.reply('Ошибка. /admin');
        this.botService.clearAdminSession(ctx);
      }
    });

    this.logger.log('Admin handlers registered');
  }

  private async handleAddDays(ctx: BotContext, text: string, step: number) {
    if (step === 1) {
      const tgId = text.replace(/\D/g, '');
      if (!tgId) return ctx.reply('Некорректный telegram_id');

      const user = await this.prisma.user.findUnique({
        where: { telegramId: BigInt(tgId) },
      });
      if (!user) return ctx.reply('Пользователь не найден');

      ctx.session.adminData = { telegramId: tgId, userId: user.id };
      ctx.session.adminStep = 2;

      return ctx.reply(
        `Пользователь: <b>${user.username || user.firstName || tgId}</b>\n\n` +
          `Отправьте: <code>дни план</code>\nПример: <code>30 standard</code>`,
        { parse_mode: 'HTML' },
      );
    }

    if (step === 2) {
      const parts = text.toLowerCase().split(/\s+/);
      const days = parseInt(parts[0], 10);
      const planStr = parts[1] || 'standard';

      if (!days || days < 1 || days > 3650) {
        return ctx.reply('Дни: 1–3650');
      }

      const plan = planStr === 'premium' ? PlanType.PREMIUM : PlanType.STANDARD;
      const userId = ctx.session.adminData!.userId;
      const active = await this.subscriptions.getActiveSubscription(userId);

      if (active && active.plan === plan) {
        await this.subscriptions.extendSubscription(active.id, days);
      } else {
        await this.subscriptions.createSubscription({
          userId,
          plan,
          days,
          isTrial: false,
        });
      }

      const tgId = ctx.session.adminData!.telegramId;
      this.botService.clearAdminSession(ctx);

      try {
        await this.botService.bot.api.sendMessage(
          Number(tgId),
          `✅ Вам начислено <b>${days} дн.</b> (${plan === PlanType.PREMIUM ? 'Премиум' : 'Стандарт'}).`,
          { parse_mode: 'HTML' },
        );
      } catch {
        /* ignore */
      }

      return ctx.reply(`✅ Начислено <b>${days}</b> дн. (${plan}) → <code>${tgId}</code>`, {
        parse_mode: 'HTML',
        reply_markup: this.manageKeyboard(),
      });
    }
  }

  private async handleBlock(ctx: BotContext, text: string, block: boolean) {
    const tgId = text.replace(/\D/g, '');
    if (!tgId) return ctx.reply('Некорректный telegram_id');

    const user = await this.prisma.user.findUnique({
      where: { telegramId: BigInt(tgId) },
    });
    if (!user) return ctx.reply('Пользователь не найден');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isBlocked: block },
    });

    if (block) {
  const subs = await this.prisma.subscription.findMany({
    where: {
      userId: user.id,
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
    },
  });

  await this.prisma.subscription.updateMany({
    where: {
      userId: user.id,
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] },
    },
    data: { status: SubscriptionStatus.CANCELLED },
  });

  for (const sub of subs) {
    await this.xray.removeUserFromPlanNodes({
      uuid: sub.uuid,
      plan: sub.plan,
    });
  }
} else {
  const cancelled = await this.prisma.subscription.findFirst({
    where: {
      userId: user.id,
      status: SubscriptionStatus.CANCELLED,
      expiresAt: { gt: new Date() },
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (cancelled) {
    const restoredStatus = cancelled.isTrial
      ? SubscriptionStatus.TRIAL
      : SubscriptionStatus.ACTIVE;

    const restored = await this.prisma.subscription.update({
      where: { id: cancelled.id },
      data: {
        status: restoredStatus,
      },
    });

    await this.xray.addUserToPlanNodes({
      uuid: restored.uuid,
      plan: restored.plan,
    });
  }
}

    this.botService.clearAdminSession(ctx);

    return ctx.reply(
      block
        ? `🚫 <code>${tgId}</code> заблокирован, доступ с нод снят.`
        : `✅ <code>${tgId}</code> разблокирован.`,
      {
        parse_mode: 'HTML',
        reply_markup: this.manageKeyboard(),
      },
    );
  }

  private async handlePromo(ctx: BotContext, text: string) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Формат: CODE скидка% [лимит]');

    const code = parts[0].toUpperCase();
    const discountPercent = parseInt(parts[1], 10);
    const maxUses = parts[2] ? parseInt(parts[2], 10) : null;

    if (!discountPercent || discountPercent < 1 || discountPercent > 100) {
      return ctx.reply('Скидка: 1–100');
    }

    if (await this.prisma.promoCode.findUnique({ where: { code } })) {
      return ctx.reply('Код уже существует');
    }

    await this.prisma.promoCode.create({
      data: { code, discountPercent, maxUses },
    });

    this.botService.clearAdminSession(ctx);
    return ctx.reply(`✅ Промокод <b>${code}</b> · ${discountPercent}%`, {
      parse_mode: 'HTML',
      reply_markup: this.manageKeyboard(),
    });
  }

  private async handleBroadcast(ctx: BotContext, text: string) {
    this.botService.clearAdminSession(ctx);
    const users = await this.prisma.user.findMany({
      where: { isBlocked: false },
      select: { telegramId: true },
    });

    let ok = 0;
    let fail = 0;
    await ctx.reply(`Отправка ${users.length}...`);

    for (const u of users) {
      try {
        await this.botService.bot.api.sendMessage(Number(u.telegramId), text, {
          parse_mode: 'HTML',
        });
        ok++;
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        fail++;
      }
    }

    return ctx.reply(`📢 ✅ ${ok}  ❌ ${fail}`, {
      reply_markup: this.manageKeyboard(),
    });
  }

  private async handleAddNode(ctx: BotContext, text: string) {
    const parts = text.split('|').map((p) => p.trim());
    if (parts.length < 7) {
      return ctx.reply('Нужно: name|host|port|type|publicKey|shortId|sni');
    }

    const [name, host, portStr, typeStr, publicKey, shortId, sni] = parts;
    const port = parseInt(portStr, 10) || 443;
    const type = typeStr.toLowerCase() === 'premium' ? NodeType.PREMIUM : NodeType.STANDARD;
    const maxUsers = type === NodeType.PREMIUM ? 50 : null;

    const node = await this.prisma.node.create({
      data: {
        name,
        host,
        port,
        type,
        maxUsers,
        publicKey,
        shortId,
        sni,
        fingerprint: 'chrome',
        isActive: true,
      },
    });

    this.botService.clearAdminSession(ctx);
    return ctx.reply(
      `✅ <b>${node.name}</b> · ${node.host}:${node.port} · ${node.type}` +
        (maxUsers ? ` · max ${maxUsers}` : ''),
      { parse_mode: 'HTML', reply_markup: this.manageKeyboard() },
    );
  }
}
