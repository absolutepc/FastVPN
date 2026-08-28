import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';

import { PrismaService } from '../prisma/prisma.service';
import { BotService } from './bot.service';
import { XrayService } from '../modules/xray/xray.service';

type AlertState = {
  offline: boolean;
  cpuHigh: boolean;
  ramHigh: boolean;
  diskHigh: boolean;
  xrayDown: boolean;
  portDown: boolean;
  apiDown: boolean;
};

@Injectable()
export class NodeMonitorService {
  private readonly logger = new Logger(NodeMonitorService.name);

  private readonly states = new Map<string, AlertState>();
  private readonly highCounters = new Map<
  string,
  { cpu: number; ram: number; disk: number }
>();

private readonly recoveryCounters = new Map<
  string,
  { cpu: number; ram: number; disk: number }
>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly botService: BotService,
    private readonly xray: XrayService,
    private readonly config: ConfigService,
  ) {}

  private getAdminIds(): number[] {
    const raw = this.config.get<string>('ADMIN_IDS') || '';

    return raw
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  private async sendToAdmins(text: string) {
    const admins = this.getAdminIds();

    for (const adminId of admins) {
      try {
        await this.botService.bot.api.sendMessage(adminId, text, {
          parse_mode: 'HTML',
        });
      } catch (e) {
        this.logger.warn(
          `Failed to send monitoring alert to ${adminId}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }

  private getNodeMetrics(host: string): Promise<any | null> {
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
            return resolve(null);
          }

          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  private flag(name: string): string {
    const n = name.toLowerCase();

    if (n.includes('germany')) return '🇩🇪';
    if (n.includes('london') || n.includes('united kingdom')) return '🇬🇧';
    if (n.includes('netherlands')) return '🇳🇱';
    if (n.includes('finland')) return '🇫🇮';
    if (n.includes('france')) return '🇫🇷';
    if (n.includes('usa') || n.includes('united states')) return '🇺🇸';

    return '🌐';
  }

  private defaultState(): AlertState {
    return {
      offline: false,
      cpuHigh: false,
      ramHigh: false,
      diskHigh: false,
      xrayDown: false,
      portDown: false,
      apiDown: false,
    };
  }

  private async processStateChange(params: {
    nodeId: string;
    nodeName: string;
    current: AlertState;
    details: string;
  }) {
    const previous = this.states.get(params.nodeId) ?? this.defaultState();

    const problems: string[] = [];
    const recovered: string[] = [];

    const checks: Array<{
      key: keyof AlertState;
      problem: string;
      recovery: string;
    }> = [
      {
        key: 'offline',
        problem: '🔴 Сервер недоступен по SSH',
        recovery: '🟢 SSH снова доступен',
      },
      {
        key: 'xrayDown',
        problem: '🔴 Xray не работает',
        recovery: '🟢 Xray снова работает',
      },
      {
        key: 'portDown',
        problem: '🔴 Порт 443 закрыт',
        recovery: '🟢 Порт 443 снова открыт',
      },
      {
        key: 'apiDown',
        problem: '🔴 Xray API недоступен',
        recovery: '🟢 Xray API снова доступен',
      },
      {
        key: 'cpuHigh',
        problem: '🔴 CPU выше 85%',
        recovery: '🟢 CPU вернулся в норму',
      },
      {
        key: 'ramHigh',
        problem: '🔴 RAM выше 85%',
        recovery: '🟢 RAM вернулась в норму',
      },
      {
        key: 'diskHigh',
        problem: '🔴 Disk выше 85%',
        recovery: '🟢 Disk вернулся в норму',
      },
    ];

    for (const check of checks) {
      if (!previous[check.key] && params.current[check.key]) {
        problems.push(check.problem);
      }

      if (previous[check.key] && !params.current[check.key]) {
        recovered.push(check.recovery);
      }
    }

    if (problems.length > 0) {
      await this.sendToAdmins(
        `🚨 <b>4StepsVPN · ALERT</b>\n\n` +
          `${this.flag(params.nodeName)} <b>${params.nodeName}</b>\n\n` +
          `${problems.join('\n')}\n\n` +
          params.details,
      );
    }

    if (recovered.length > 0) {
      await this.sendToAdmins(
        `✅ <b>4StepsVPN · RECOVERED</b>\n\n` +
          `${this.flag(params.nodeName)} <b>${params.nodeName}</b>\n\n` +
          `${recovered.join('\n')}\n\n` +
          params.details,
      );
    }

    this.states.set(params.nodeId, params.current);
  }

  private getCounters(
  map: Map<string, { cpu: number; ram: number; disk: number }>,
  nodeId: string,
) {
  let counters = map.get(nodeId);

  if (!counters) {
    counters = { cpu: 0, ram: 0, disk: 0 };
    map.set(nodeId, counters);
  }

  return counters;
}

private applyResourceDebounce(params: {
  nodeId: string;
  cpu: number;
  ram: number;
  disk: number;
  previous: AlertState;
}) {
  const high = this.getCounters(this.highCounters, params.nodeId);
  const recovery = this.getCounters(this.recoveryCounters, params.nodeId);

  const result = {
    cpuHigh: params.previous.cpuHigh,
    ramHigh: params.previous.ramHigh,
    diskHigh: params.previous.diskHigh,
  };

  const resources = [
    { key: 'cpu' as const, stateKey: 'cpuHigh' as const, value: params.cpu },
    { key: 'ram' as const, stateKey: 'ramHigh' as const, value: params.ram },
    { key: 'disk' as const, stateKey: 'diskHigh' as const, value: params.disk },
  ];

  for (const resource of resources) {
    const active = params.previous[resource.stateKey];

    if (!active) {
      recovery[resource.key] = 0;

      if (resource.value >= 85) {
        high[resource.key] += 1;

        if (high[resource.key] >= 3) {
          result[resource.stateKey] = true;
          high[resource.key] = 0;
        }
      } else {
        high[resource.key] = 0;
      }
    } else {
      high[resource.key] = 0;

      if (resource.value < 70) {
        recovery[resource.key] += 1;

        if (recovery[resource.key] >= 2) {
          result[resource.stateKey] = false;
          recovery[resource.key] = 0;
        }
      } else {
        recovery[resource.key] = 0;
      }
    }
  }

  return result;
}

  @Cron('* * * * *')
  async checkNodes() {
    if (this.running) return;
    this.running = true;

    try {
      const nodes = await this.prisma.node.findMany({
        where: { isActive: true },
      });

      for (const node of nodes) {
        const metrics = await this.getNodeMetrics(node.host);
        const apiAlive = await this.xray.pingNode(node);

        if (!metrics) {
          await this.processStateChange({
            nodeId: node.id,
            nodeName: node.name,
            current: {
              ...this.defaultState(),
              offline: true,
              apiDown: !apiAlive,
            },
            details:
              `🌐 <code>${node.host}:${node.port}</code>\n` +
              `Xray API: ${apiAlive ? '🟢 OK' : '🔴 FAIL'}`,
          });

          continue;
        }

        const cpu = Number(metrics.cpu_percent ?? 0);
        const ram = Number(metrics.ram?.percent ?? 0);
        const disk = Number(metrics.disk?.percent ?? 0);

        const previous =
  this.states.get(node.id) ?? this.defaultState();

const resourceState = this.applyResourceDebounce({
  nodeId: node.id,
  cpu,
  ram,
  disk,
  previous,
});

const current: AlertState = {
  offline: false,
  cpuHigh: resourceState.cpuHigh,
  ramHigh: resourceState.ramHigh,
  diskHigh: resourceState.diskHigh,
  xrayDown: metrics.xray !== 'active',
  portDown: metrics.port_443 !== 'open',
  apiDown: !apiAlive,
};

        await this.processStateChange({
          nodeId: node.id,
          nodeName: node.name,
          current,
          details:
            `CPU: <b>${cpu.toFixed(1)}%</b>\n` +
            `RAM: <b>${ram.toFixed(1)}%</b>\n` +
            `Disk: <b>${disk.toFixed(0)}%</b>\n` +
            `Xray: ${metrics.xray === 'active' ? '🟢' : '🔴'} ${metrics.xray}\n` +
            `443: ${metrics.port_443 === 'open' ? '🟢' : '🔴'} ${metrics.port_443}`,
        });
      }
    } catch (e) {
      this.logger.error(
        'Node monitoring cycle failed',
        e instanceof Error ? e.message : e,
      );
    } finally {
      this.running = false;
    }
  }
}
