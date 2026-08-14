import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { execFile } from 'child_process';

import { BotService } from './bot.service';
import { PrismaService } from '../prisma/prisma.service';

type SeenUser = {
  ips: Set<string>;
  nodes: Set<string>;
  connections: number;
};

type DeviceState = {
  ipLastSeen: Record<string, number>;
  violations: number;
  alertSent: boolean;
};

@Injectable()
export class DeviceLimitService {
  private readonly logger = new Logger(DeviceLimitService.name);

  private readonly states = new Map<string, DeviceState>();
  private running = false;

  private readonly sshKey = '/root/.ssh/4stepsvpn_xray';

  // Логи читаем за 2 минуты
  private readonly logWindow = '2 minutes ago';

  // IP считается "активным", если был замечен не более 5 минут назад
  private readonly activeIpTtlMs = 5 * 60 * 1000;

  // Сколько подтверждений нужно до CONFIRMED
  private readonly requiredViolations = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly botService: BotService,
  ) {}

  private getNodeLogs(host: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/ssh',
        [
          '-i',
          this.sshKey,
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          '-o',
          'StrictHostKeyChecking=yes',
          `root@${host}`,
          `journalctl -u xray --since "${this.logWindow}" --no-pager`,
        ],
        {
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            return resolve(null);
          }

          resolve(stdout);
        },
      );
    });
  }

  @Cron('*/2 * * * *')
  async checkDeviceLimits() {
    if (this.running) return;

    this.running = true;

    try {
      const now = Date.now();

      const nodes = await this.prisma.node.findMany({
        where: {
          isActive: true,
        },
      });

      const seen = new Map<string, SeenUser>();

      for (const node of nodes) {
        const output = await this.getNodeLogs(node.host);

        if (output === null) {
          this.logger.warn(
            `Device limit check skipped for ${node.name}: log unavailable`,
          );
          continue;
        }

        for (const line of output.split('\n')) {
          const match = line.match(
            /from\s+(?:tcp:)?(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s+accepted.*email:\s+([^\s]+)/,
          );

          if (!match) continue;

          const ip = match[1];
          const email = match[3];

          if (!email.endsWith('@4stepsvpn.local')) {
            continue;
          }

          const uuid = email.replace('@4stepsvpn.local', '');

          let entry = seen.get(uuid);

          if (!entry) {
            entry = {
              ips: new Set<string>(),
              nodes: new Set<string>(),
              connections: 0,
            };

            seen.set(uuid, entry);
          }

          entry.ips.add(ip);
          entry.nodes.add(node.name);
          entry.connections += 1;
        }
      }

      // Обновляем lastSeen для IP, которые появились в текущем цикле
      for (const [uuid, data] of seen.entries()) {
        let state = this.states.get(uuid);

        if (!state) {
          state = {
            ipLastSeen: {},
            violations: 0,
            alertSent: false,
          };

          this.states.set(uuid, state);
        }

        for (const ip of data.ips) {
          state.ipLastSeen[ip] = now;
        }
      }

      // Проверяем все UUID, которые есть в state
      for (const [uuid, state] of this.states.entries()) {
        // Удаляем давно неактивные IP
        for (const [ip, lastSeen] of Object.entries(state.ipLastSeen)) {
          if (now - lastSeen > this.activeIpTtlMs) {
            delete state.ipLastSeen[ip];
          }
        }

        const activeIps = Object.keys(state.ipLastSeen);

        const subscription =
          await this.prisma.subscription.findUnique({
            where: {
              uuid,
            },
            include: {
              user: true,
            },
          });

        if (!subscription) {
          continue;
        }

        const violation = activeIps.length > 1;

        if (violation) {
          state.violations += 1;
        } else {
          state.violations = 0;
          state.alertSent = false;
        }

        const confirmed =
          state.violations >= this.requiredViolations;

        const currentSeen = seen.get(uuid);

        if (confirmed) {
  this.logger.error(
    `DEVICE LIMIT CONFIRMED: ` +
      `user=${subscription.user.username ?? '-'} ` +
      `telegram=${subscription.user.telegramId.toString()} ` +
      `uuid=${uuid} ` +
      `plan=${subscription.plan} ` +
      `ips=${activeIps.join(',')} ` +
      `counter=${state.violations}/${this.requiredViolations} ` +
      `nodes=${currentSeen ? [...currentSeen.nodes].join(',') : '-'} ` +
      `connections=${currentSeen?.connections ?? 0}`,
  );

  if (!state.alertSent) {
    const adminsRaw = process.env.ADMIN_IDS || '';

    const adminIds = adminsRaw
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);

    const text =
      `🚨 <b>4StepsVPN · DEVICE LIMIT</b>\n\n` +
      `Пользователь: <b>${subscription.user.username ?? '-'}</b>\n` +
      `Telegram ID: <code>${subscription.user.telegramId.toString()}</code>\n` +
      `Тариф: <b>${subscription.plan}</b>\n\n` +
      `Обнаружено IP: <b>${activeIps.length}</b>\n` +
      `${activeIps.map((ip) => `• <code>${ip}</code>`).join('\n')}\n\n` +
      `UUID: <code>${uuid}</code>\n` +
      `Ноды: ${currentSeen ? [...currentSeen.nodes].join(', ') : '-'}`;

    for (const adminId of adminIds) {
      try {
        await this.botService.bot.api.sendMessage(
          adminId,
          text,
          {
            parse_mode: 'HTML',
          },
        );
      } catch (e) {
        this.logger.warn(
          `Failed to send device limit alert to ${adminId}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }

    state.alertSent = true;
  }

  continue;
}

        if (violation) {
          this.logger.warn(
            `DEVICE LIMIT SUSPECT: ` +
              `user=${subscription.user.username ?? '-'} ` +
              `telegram=${subscription.user.telegramId.toString()} ` +
              `uuid=${uuid} ` +
              `ips=${activeIps.join(',')} ` +
              `counter=${state.violations}/${this.requiredViolations}`,
          );
        } else {
          this.logger.debug(
            `DEVICE LIMIT OK: uuid=${uuid} ` +
              `ip=${activeIps[0] ?? '-'}`
          );
        }
      }
    } catch (e) {
      this.logger.error(
        'Device limit cycle failed',
        e instanceof Error ? e.message : e,
      );
    } finally {
      this.running = false;
    }
  }
}
