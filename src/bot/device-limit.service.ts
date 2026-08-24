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
  violations: number;
  alertSent: boolean;
};

@Injectable()
export class DeviceLimitService {
  private readonly logger = new Logger(DeviceLimitService.name);

  private readonly states = new Map<string, DeviceState>();
  private running = false;

  private readonly sshKey = '/root/.ssh/4stepsvpn_xray';

  // Смотрим только свежие подключения за текущий интервал проверки.
  private readonly logWindow = '2 minutes ago';

  // Нарушение должно повториться несколько циклов подряд.
  // Cron запускается каждые 2 минуты, поэтому случайная смена сети
  // Wi-Fi -> LTE не должна приводить к CONFIRMED.
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
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const nodes = await this.prisma.node.findMany({
        where: {
          isActive: true,
        },
      });

      /*
       * ВАЖНО:
       *
       * IP больше не сохраняются между циклами.
       *
       * Раньше старый IP хранился ещё 5 минут, поэтому обычное
       * переключение Wi-Fi -> LTE могло выглядеть как два устройства.
       *
       * Теперь учитываются только IP, реально замеченные
       * в текущем окне журналов.
       */
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

          if (!match) {
            continue;
          }

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

      /*
       * Если UUID вообще не появился в текущем цикле,
       * предыдущую серию подозрений сбрасываем.
       *
       * Это не позволяет старым IP влиять на следующие проверки.
       */
      for (const uuid of [...this.states.keys()]) {
        if (!seen.has(uuid)) {
          this.states.delete(uuid);
        }
      }

      for (const [uuid, data] of seen.entries()) {
        let state = this.states.get(uuid);

        if (!state) {
          state = {
            violations: 0,
            alertSent: false,
          };

          this.states.set(uuid, state);
        }

        const activeIps = [...data.ips];

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
          this.states.delete(uuid);
          continue;
        }

        /*
         * Этот UUID реально появился в свежих Xray-логах,
         * значит устройство недавно использовало VPN.
         *
         * DeviceLimitService уже выполняет SSH-проверку нод,
         * поэтому отдельный опрос для WebApp не нужен.
         */
        await this.prisma.device.updateMany({
          where: {
            subscriptionId:
              subscription.id,
            isActive:
              true,
          },
          data: {
            lastSeenAt:
              new Date(),
          },
        });

        /*
         * Для MVP несколько IP являются только сигналом.
         *
         * Мы НЕ блокируем подписку автоматически.
         * IP не является надёжным идентификатором устройства.
         */
        const violation = activeIps.length > 1;

        if (violation) {
          state.violations += 1;
        } else {
          state.violations = 0;
          state.alertSent = false;
        }

        const confirmed =
          state.violations >= this.requiredViolations;

        if (confirmed) {
          this.logger.error(
            `DEVICE LIMIT CONFIRMED: ` +
              `user=${subscription.user.username ?? '-'} ` +
              `telegram=${subscription.user.telegramId.toString()} ` +
              `uuid=${uuid} ` +
              `plan=${subscription.plan} ` +
              `ips=${activeIps.join(',')} ` +
              `counter=${state.violations}/${this.requiredViolations} ` +
              `nodes=${[...data.nodes].join(',')} ` +
              `connections=${data.connections}`,
          );

          if (!state.alertSent) {
            const adminsRaw = process.env.ADMIN_IDS || '';

            const adminIds = adminsRaw
              .split(',')
              .map((id) => Number(id.trim()))
              .filter(
                (id) =>
                  Number.isFinite(id) &&
                  id > 0,
              );

            const text =
              `🚨 <b>4StepsVPN · DEVICE LIMIT</b>\n\n` +
              `Пользователь: <b>${subscription.user.username ?? '-'}</b>\n` +
              `Telegram ID: <code>${subscription.user.telegramId.toString()}</code>\n` +
              `Тариф: <b>${subscription.plan}</b>\n\n` +
              `Одновременно обнаружено IP: <b>${activeIps.length}</b>\n` +
              `${activeIps
                .map(
                  (ip) =>
                    `• <code>${ip}</code>`,
                )
                .join('\n')}\n\n` +
              `UUID: <code>${uuid}</code>\n` +
              `Ноды: ${[...data.nodes].join(', ')}`;

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
                    e instanceof Error
                      ? e.message
                      : e
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
              `counter=${state.violations}/${this.requiredViolations} ` +
              `nodes=${[...data.nodes].join(',')} ` +
              `connections=${data.connections}`,
          );
        } else {
          this.logger.debug(
            `DEVICE LIMIT OK: ` +
              `uuid=${uuid} ` +
              `ip=${activeIps[0] ?? '-'} ` +
              `nodes=${[...data.nodes].join(',')} ` +
              `connections=${data.connections}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(
        'Device limit cycle failed',
        e instanceof Error
          ? e.message
          : e,
      );
    } finally {
      this.running = false;
    }
  }
}
