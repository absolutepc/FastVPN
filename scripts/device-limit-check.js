const { PrismaClient } = require('@prisma/client');
const { execFileSync } = require('child_process');
const fs = require('fs');

const prisma = new PrismaClient();

const SSH_KEY = '/root/.ssh/4stepsvpn_xray';
const WINDOW = '2 minutes ago';
const STATE_FILE = '/opt/FastVPN/.device-limit-state.json';
const REQUIRED_VIOLATIONS = 3;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
  );
}

(async () => {
  const state = loadState();

  const nodes = await prisma.node.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  const seen = new Map();

  for (const node of nodes) {
    let output = '';

    try {
      output = execFileSync(
        '/usr/bin/ssh',
        [
          '-i', SSH_KEY,
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=5',
          '-o', 'StrictHostKeyChecking=yes',
          `root@${node.host}`,
          `journalctl -u xray --since "${WINDOW}" --no-pager`,
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch {
      console.log(`⚠️ ${node.name}: log read failed`);
      continue;
    }

    for (const line of output.split('\n')) {
      const match = line.match(
        /from\s+(\S+):(\d+)\s+accepted.*email:\s+([^\s]+)/,
      );

      if (!match) continue;

      const ip = match[1];
      const email = match[3];

      if (!email.endsWith('@4stepsvpn.local')) continue;

      const uuid = email.replace('@4stepsvpn.local', '');

      if (!seen.has(uuid)) {
        seen.set(uuid, {
          ips: new Set(),
          nodes: new Set(),
          connections: 0,
        });
      }

      const item = seen.get(uuid);

      item.ips.add(ip);
      item.nodes.add(node.name);
      item.connections++;
    }
  }

  console.log('');
  console.log('=== 4StepsVPN DEVICE WATCH ===');
  console.log(`Window: ${WINDOW}`);
  console.log(`Confirmations required: ${REQUIRED_VIOLATIONS}`);
  console.log('');

  for (const [uuid, data] of seen.entries()) {
    const sub = await prisma.subscription.findUnique({
      where: { uuid },
      include: { user: true },
    });

    const ips = [...data.ips];
    const violation = ips.length > 1;

    if (!state[uuid]) {
      state[uuid] = {
        violations: 0,
      };
    }

    if (violation) {
      state[uuid].violations += 1;
    } else {
      state[uuid].violations = 0;
    }

    const confirmed =
      state[uuid].violations >= REQUIRED_VIOLATIONS;

    console.log(
      `${confirmed
        ? '🚨 CONFIRMED'
        : violation
          ? '⚠️ SUSPECT'
          : '✅ OK'} ${sub?.user?.username || 'unknown'}`
    );

    console.log(
      `  Telegram: ${sub?.user?.telegramId?.toString() || '-'}`
    );
    console.log(`  UUID: ${uuid}`);
    console.log(`  Plan: ${sub?.plan || '-'}`);
    console.log(`  Status: ${sub?.status || '-'}`);
    console.log(`  IP count: ${ips.length}`);
    console.log(`  IPs: ${ips.join(', ')}`);
    console.log(
      `  Violation counter: ${state[uuid].violations}/${REQUIRED_VIOLATIONS}`
    );
    console.log(`  Nodes: ${[...data.nodes].join(', ')}`);
    console.log(`  Connections: ${data.connections}`);
    console.log('');
  }

  saveState(state);
})()
.catch(console.error)
.finally(() => prisma.$disconnect());
