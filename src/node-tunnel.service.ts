import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { XrayService } from './modules/xray/xray.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';

const execFileAsync = promisify(execFile);

@Injectable()
export class NodeTunnelService {
  private readonly logger = new Logger(NodeTunnelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly xray: XrayService,
  ) {}

  private async portIsBusy(port: number): Promise<boolean> {
    try {
      await execFileAsync('/usr/bin/ss', [
        '-lnt',
        `sport = :${port}`,
      ]);

      const { stdout } = await execFileAsync('/usr/bin/ss', [
        '-lnt',
      ]);

      return stdout.includes(`127.0.0.1:${port}`);
    } catch {
      return false;
    }
  }

  private async findFreePort(): Promise<number> {
  for (let port = 11086; port <= 11999; port++) {
    const busyOnHost = await this.portIsBusy(port);

    const usedInDb = await this.prisma.node.findFirst({
      where: {
        apiHost: '127.0.0.1',
        apiPort: port,
      },
      select: {
        id: true,
      },
    });

    if (!busyOnHost && !usedInDb) {
      return port;
    }
  }

  throw new Error('No free tunnel ports');
}

  async setupTunnel(nodeId: string) {
  const node = await this.prisma.node.findUnique({
    where: { id: nodeId },
  });

  if (!node) {
    throw new Error('Node not found');
  }

  const serviceName =
    `4stepsvpn-xray-tunnel-${node.id}.service`;

  const servicePath =
    `/etc/systemd/system/${serviceName}`;

  // Если для этой ноды уже был выделен tunnel port,
  // переиспользуем его. Иначе ищем новый.
  let localPort: number;

  if (
    node.apiHost === '127.0.0.1' &&
    node.apiPort >= 11086 &&
    node.apiPort <= 11999
  ) {
    localPort = node.apiPort;
  } else {
    localPort = await this.findFreePort();
  }

  // Останавливаем предыдущую версию tunnel service,
  // если она уже существует.
  await execFileAsync('/usr/bin/systemctl', [
    'disable',
    '--now',
    serviceName,
  ]).catch(() => undefined);

  const unit = `[Unit]
Description=4StepsVPN Xray API SSH Tunnel ${node.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -N -i /root/.ssh/4stepsvpn_xray -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -L 127.0.0.1:${localPort}:127.0.0.1:10085 root@${node.host}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  await writeFile(servicePath, unit, {
    mode: 0o644,
  });

  await execFileAsync('/usr/bin/systemctl', [
    'daemon-reload',
  ]);

  await execFileAsync('/usr/bin/systemctl', [
    'enable',
    serviceName,
  ]);

  await execFileAsync('/usr/bin/systemctl', [
    'restart',
    serviceName,
  ]);

  await new Promise((resolve) =>
    setTimeout(resolve, 2500),
  );

  const updated = await this.prisma.node.update({
    where: { id: node.id },
    data: {
      apiHost: '127.0.0.1',
      apiPort: localPort,
      isActive: false,
    },
  });

  const alive = await this.xray.pingNode(updated);

  if (!alive) {
  await execFileAsync('/usr/bin/systemctl', [
    'disable',
    '--now',
    serviceName,
  ]).catch(() => undefined);

  await execFileAsync('/usr/bin/rm', [
    '-f',
    servicePath,
  ]).catch(() => undefined);

  await execFileAsync('/usr/bin/systemctl', [
    'daemon-reload',
  ]).catch(() => undefined);

  await this.prisma.node.update({
    where: { id: node.id },
    data: {
      apiHost: null,
      apiPort: 10085,
      isActive: false,
    },
  });

  throw new Error(
    `Xray API unavailable through tunnel ${localPort}`,
  );
}

  const sync = await this.xray.syncActiveUsersToNode(updated);

if (sync.fail > 0) {
  await execFileAsync('/usr/bin/systemctl', [
    'disable',
    '--now',
    serviceName,
  ]).catch(() => undefined);

  await execFileAsync('/usr/bin/rm', [
    '-f',
    servicePath,
  ]).catch(() => undefined);

  await execFileAsync('/usr/bin/systemctl', [
    'daemon-reload',
  ]).catch(() => undefined);

  await this.prisma.node.update({
    where: { id: node.id },
    data: {
      apiHost: null,
      apiPort: 10085,
      isActive: false,
    },
  });

  throw new Error(
    `User sync failed: ${sync.fail}/${sync.total}`,
  );
}

  const activated = await this.prisma.node.update({
    where: { id: node.id },
    data: {
      isActive: true,
    },
  });

  this.logger.log(
    `Node ${activated.name} activated via 127.0.0.1:${localPort}`,
  );

  return {
    ok: true,
    nodeId: activated.id,
    apiPort: localPort,
    sync,
    serviceName,
  };
}
}
