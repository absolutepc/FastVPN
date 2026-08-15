(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#050505');
      tg.setBackgroundColor('#050505');
    } catch (_) {}
  }

  const $ = (id) => document.getElementById(id);
  const API_BASE = window.location.origin;
  let cabinet = null;

  function getInitData() {
    if (tg?.initData) return tg.initData;
    return '';
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано');
      tg?.HapticFeedback?.notificationOccurred?.('success');
    } catch {
      toast('Не удалось скопировать');
    }
  }

  function daysLeft(iso) {
    return Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000));
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return '—';
    }
  }

  function pluralDays(n) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return n + ' день';
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return n + ' дня';
    return n + ' дней';
  }

  function showScreen(name) {
    const main = ['home', 'servers', 'devices', 'sub', 'profile'];
    const all = [...main, 'promo', 'ref', 'admin'];
    all.forEach((s) => $(`screen-${s}`)?.classList.toggle('hidden', s !== name));
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    $('tabbar').style.display = main.includes(name) ? 'flex' : 'none';
    window.scrollTo(0, 0);
  }

  /* ----- Banner carousel ----- */
  function initBannerCarousel() {
    const track = $('banner-track');
    const dotsWrap = $('banner-dots');
    if (!track || !dotsWrap) return;

    const slides = track.querySelectorAll('.slide');
    const dots = dotsWrap.querySelectorAll('.dot');
    const total = slides.length;
    if (!total) return;

    let index = 0;
    let timer = null;
    let startX = 0;
    let deltaX = 0;
    let dragging = false;

    function go(i) {
      index = (i + total) % total;
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((d, n) => d.classList.toggle('active', n === index));
    }

    function next() {
      go(index + 1);
    }

    function startAuto() {
      stopAuto();
      timer = setInterval(next, 4500);
    }

    function stopAuto() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    dots.forEach((d, n) => {
      d.style.cursor = 'pointer';
      d.addEventListener('click', () => {
        go(n);
        startAuto();
      });
    });

    track.addEventListener(
      'touchstart',
      (e) => {
        dragging = true;
        startX = e.touches[0].clientX;
        deltaX = 0;
        stopAuto();
      },
      { passive: true },
    );

    track.addEventListener(
      'touchmove',
      (e) => {
        if (!dragging) return;
        deltaX = e.touches[0].clientX - startX;
      },
      { passive: true },
    );

    track.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      if (deltaX < -40) go(index + 1);
      else if (deltaX > 40) go(index - 1);
      startAuto();
    });

    track.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-go');
        if (target) showScreen(target);
      });
    });

    go(0);
    startAuto();
  }

  function render(data) {
    cabinet = data;
    const name = data.user?.firstName || data.user?.username || 'друг';
    $('greet-name').textContent = name;
    $('user-name').textContent = name;
    $('avatar').textContent = (name[0] || '?').toUpperCase();
    $('user-meta').textContent = data.user?.username
      ? `@${data.user.username}`
      : `ID: ${data.user?.id?.slice?.(-6) || '—'}`;
    $('ref-link').textContent = data.referralLink || '—';
    $('menu-admin').style.display = data.isAdmin ? '' : 'none';

    const sub = data.subscription;
    const state = data.subscriptionState || (sub ? 'ACTIVE' : 'NONE');
    const deviceLimit = data.deviceLimit ?? 1;
    const deviceUsed = data.deviceUsed ?? 0;
    const left = data.daysLeft ?? (sub ? daysLeft(sub.expiresAt) : 0);
    const subDays = $('days-num')?.closest('.sub-days');

    if (state === 'ACTIVE' && sub) {
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';

      if (subDays) subDays.style.display = '';
      $('greet-status').textContent = 'Ваш доступ активен';
      $('greet-status').className = 'hello-sub on';
      $('status-dot').className = 'status-dot on';
      $('hero-title').textContent = 'Подписка активна';
      $('hero-sub').textContent = sub.isTrial ? 'Пробный период · вы в безопасности' : 'Вы в безопасности';
      $('server-chip').hidden = false;
      $('server-chip').style.display = '';
      $('server-chip-text').textContent = planName;
      $('btn-renew').textContent = 'Продлить подписку ›';

      $('stat-days').textContent = String(left);
      $('stat-days-bar').style.width = Math.min(100, Math.round((left / 30) * 100)) + '%';
      $('stat-devices').textContent = `${deviceUsed} из ${deviceLimit}`;
      $('stat-net').textContent = planName;
      $('stat-net-lbl').textContent = 'тариф';

      $('sub-url').textContent = sub.subUrl;
      $('smart-desc').textContent = 'Нажмите, чтобы скопировать';

      $('sub-plan-name').textContent = planName;
      $('sub-plan-desc').textContent =
        sub.plan === 'PREMIUM' ? 'Максимум возможностей для вашего комфорта' : 'Базовый доступ';
      $('sub-badge').hidden = false;
      $('days-num').textContent = pluralDays(left);
      $('days-until').textContent = 'До ' + formatDate(sub.expiresAt);
      $('progress-bar').style.width = Math.min(100, Math.round((left / 30) * 100)) + '%';

      $('ps-plan').textContent = '1';
      $('dev-count').textContent = `${deviceUsed} из ${deviceLimit}`;
      $('dev-avail').textContent = 'Лимит тарифа';
      $('dev-bar').style.width = `${Math.min(100, Math.round((deviceUsed / Math.max(1, deviceLimit)) * 100))}%`;
      $('btn-add-device').style.display = '';
      $('dev-list').innerHTML =
        '<div class="dev-item">' +
        '<div class="dev-item-ico">📱</div>' +
        '<div><div class="dev-item-name">1 устройство</div>' +
        '<div class="dev-item-meta">Доступно по подписке · ' + planName + '</div></div>' +
        '<span class="dev-online">Активно</span></div>';
      return;
    }

    $('greet-status').className = 'hello-sub';
    $('status-dot').className = 'status-dot';
    $('server-chip').hidden = true;
    $('server-chip').style.display = 'none';
    $('stat-days').textContent = '0';
    $('stat-days-bar').style.width = '0%';
    $('stat-devices').textContent = `0 из ${deviceLimit}`;
    $('stat-net').textContent = '—';
    $('stat-net-lbl').textContent = 'тариф';
    $('sub-badge').hidden = true;
    $('days-num').textContent = '—';
    $('days-until').textContent = '';
    $('progress-bar').style.width = '0%';
    $('ps-plan').textContent = '0';
    $('dev-count').textContent = `0 из ${deviceLimit}`;
    $('dev-avail').textContent = `Доступно ещё ${deviceLimit}`;
    $('dev-bar').style.width = '0%';
    $('btn-add-device').style.display = 'none';

    if (state === 'EXPIRED') {
      if (subDays) subDays.style.display = '';
      $('days-num').textContent = '0 дней';
      $('days-until').textContent = 'Срок действия закончился';
      $('greet-status').textContent = 'Срок подписки истёк';
      $('hero-title').textContent = 'Подписка истекла';
      $('hero-sub').textContent = 'Продлите подписку, чтобы восстановить доступ';
      $('sub-url').textContent = 'Доступ приостановлен';
      $('smart-desc').textContent = 'Продлите подписку для получения доступа';
      $('sub-plan-name').textContent = 'Подписка истекла';
      $('sub-plan-desc').textContent = 'Продлите тариф, чтобы снова подключиться';
      $('btn-renew').textContent = 'Купить подписку ›';
      $('dev-list').innerHTML =
        '<div class="dev-empty" id="dev-empty">Подписка истекла.<br/>После продления доступ на устройстве восстановится.</div>';
      return;
    }

    if (subDays) subDays.style.display = 'none';
    $('greet-status').textContent = 'Подписка не оформлена';
    $('hero-title').textContent = 'Подписка не активна';
    $('hero-sub').textContent = 'Оформите тариф, чтобы начать';
    $('sub-url').textContent = 'Нет активной подписки';
    $('smart-desc').textContent = 'Сначала оформите подписку';
    $('sub-plan-name').textContent = 'Нет подписки';
    $('sub-plan-desc').textContent = 'Выберите тариф ниже';
    $('btn-renew').textContent = 'Купить подписку ›';
    $('dev-list').innerHTML =
      '<div class="dev-empty" id="dev-empty">Нет активной подписки.<br/>После оплаты здесь появится ваше устройство.</div>';
  }

  function adminFlag(name) {
    const value = String(name || '').toLowerCase();
    if (value.includes('germany')) return '🇩🇪';
    if (value.includes('finland')) return '🇫🇮';
    if (value.includes('netherlands')) return '🇳🇱';
    if (value.includes('france')) return '🇫🇷';
    if (value.includes('sweden')) return '🇸🇪';
    if (value.includes('usa') || value.includes('united states')) return '🇺🇸';
    return '🌐';
  }

  function adminNumber(value, digits = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '—';
  }

  function adminBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes.toFixed(0) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let result = bytes;
    let unit = -1;
    do {
      result /= 1024;
      unit += 1;
    } while (result >= 1024 && unit < units.length - 1);
    return result.toFixed(result >= 100 ? 0 : 1) + ' ' + units[unit];
  }

  function closeAdminNodeModal() {
    $('admin-node-modal').classList.add('hidden');
    document.body.classList.remove('admin-modal-open');
  }

  function openAdminNodeModal(params) {
    $('admin-modal-flag').textContent = params.flag;
    $('admin-modal-title').textContent = params.name;
    $('admin-modal-subtitle').textContent = params.subtitle || '';

    const status = $('admin-modal-status');
    status.className = 'admin-node-status ' + (params.online ? 'online' : 'offline');
    status.textContent = params.online ? 'ONLINE' : 'OFFLINE';

    const details = $('admin-modal-details');
    details.replaceChildren();

    for (const row of params.rows || []) {
      const item = document.createElement('div');
      item.className = 'admin-modal-row';

      const label = document.createElement('span');
      label.textContent = row.label;

      const value = document.createElement('strong');
      value.textContent = row.value;

      item.append(label, value);
      details.append(item);
    }

    $('admin-node-modal').classList.remove('hidden');
    document.body.classList.add('admin-modal-open');
    tg?.HapticFeedback?.selectionChanged?.();
  }

  function addAdminNode(container, params) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'admin-node';

    const flag = document.createElement('div');
    flag.className = 'admin-node-flag';
    flag.textContent = params.flag;

    const body = document.createElement('div');
    body.className = 'admin-node-body';

    const title = document.createElement('div');
    title.className = 'admin-node-title';
    title.textContent = params.name;

    const meta = document.createElement('div');
    meta.className = 'admin-node-meta';
    meta.textContent = params.meta;

    const status = document.createElement('div');
    status.className = 'admin-node-status ' + (params.online ? 'online' : 'offline');
    status.textContent = params.online ? 'ONLINE' : 'OFFLINE';

    const chevron = document.createElement('span');
    chevron.className = 'admin-node-chevron';
    chevron.textContent = '›';

    body.append(title, meta);
    card.append(flag, body, status, chevron);
    card.onclick = () => openAdminNodeModal(params);
    container.append(card);
  }

  function renderAdminDashboard(data) {
    $('admin-users').textContent = String(data.stats?.users ?? 0);
    $('admin-active').textContent = String(data.stats?.activeSubscriptions ?? 0);
    $('admin-trials').textContent = String(data.stats?.trials ?? 0);
    $('admin-revenue').textContent = String(data.stats?.revenueRub ?? 0) + ' ₽';
    $('admin-expiring').textContent = String(data.stats?.expiringToday ?? 0);
    $('admin-servers').textContent = String(data.stats?.servers ?? 0);

    const nodes = $('admin-node-list');
    nodes.replaceChildren();

    for (const node of data.nodes || []) {
      const metrics = node.metrics;
      const xrayActive = metrics?.xray === 'active';
      const portOpen = metrics?.port_443 === 'open';
      const online = Boolean(node.apiOnline && metrics && xrayActive && portOpen);
      const rows = [
        { label: 'Адрес', value: String(node.host || '—') + ':' + String(node.port ?? '—') },
        { label: 'Тип', value: String(node.type || '—') },
        { label: 'Xray API', value: node.apiOnline ? '🟢 Доступен' : '🔴 Недоступен' },
        { label: 'Пользователи', value: String(node.users ?? 0) + ' / ' + String(node.maxUsers ?? '∞') },
      ];

      if (metrics) {
        rows.push(
          { label: 'CPU', value: adminNumber(metrics.cpu_percent) + '%' },
          {
            label: 'RAM',
            value:
              String(metrics.ram?.used_mb ?? '—') +
              ' / ' +
              String(metrics.ram?.total_mb ?? '—') +
              ' MB (' +
              adminNumber(metrics.ram?.percent) +
              '%)',
          },
          {
            label: 'Диск',
            value:
              String(metrics.disk?.used ?? '—') +
              ' / ' +
              String(metrics.disk?.total ?? '—') +
              ' (' +
              adminNumber(metrics.disk?.percent, 0) +
              '%)',
          },
          { label: 'Load 1m', value: String(metrics.load_1m ?? '—') },
          { label: 'Uptime', value: String(metrics.uptime ?? '—') },
          { label: 'Xray', value: xrayActive ? '🟢 active' : '🔴 down' },
          { label: 'Порт 443', value: portOpen ? '🟢 open' : '🔴 closed' },
          { label: 'Подключения', value: String(metrics.connections_443 ?? 0) },
          { label: 'Трафик ↓', value: adminBytes(metrics.network?.rx_bytes) },
          { label: 'Трафик ↑', value: adminBytes(metrics.network?.tx_bytes) },
        );
      } else {
        rows.push({ label: 'Метрики сервера', value: '🔴 Недоступны по SSH' });
      }

      addAdminNode(nodes, {
        flag: adminFlag(node.name),
        name: node.name,
        subtitle: 'Xray Node',
        online,
        meta:
          'Xray API · ' +
          String(node.users ?? 0) +
          ' / ' +
          String(node.maxUsers ?? '∞') +
          ' пользователей',
        rows,
      });
    }

    const h1Nodes =
      Array.isArray(data.h1CloudNodes) &&
      data.h1CloudNodes.length > 0
        ? data.h1CloudNodes
        : [{
            nodeKey: 'FI1',
            name: '🇫🇮 Finland',
            ...(data.h1Cloud || {}),
          }];

    const h1Displays = {
      FI1: { flag: '🇫🇮', name: 'Finland' },
      ES1: { flag: '🇪🇸', name: 'Spain' },
      PL1: { flag: '🇵🇱', name: 'Poland' },
    };

    for (const h1 of h1Nodes) {
      const display = h1Displays[h1.nodeKey] || {
        flag: '🌐',
        name: String(h1.name || h1.nodeKey || 'H1Cloud'),
      };

      const synchronized =
        Number(h1.clients ?? 0) ===
        Number(h1.expected ?? 0);

      const h1Online = Boolean(
        h1.apiOk && synchronized,
      );

      const latency = Number.isFinite(Number(h1.latencyMs))
        ? String(h1.latencyMs) + ' мс'
        : '—';

      const inboundParts = h1.inbound
        ? [
            h1.inbound.protocol,
            h1.inbound.security,
            h1.inbound.network,
          ]
            .filter(Boolean)
            .map((value) => String(value).toUpperCase())
            .join(' · ')
        : '—';

      const nearestExpiry = h1.nearestExpiry
        ? new Date(h1.nearestExpiry).toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '—';

      addAdminNode(nodes, {
        flag: display.flag,
        name: display.name,
        subtitle: 'H1Cloud',
        online: h1Online,
        meta:
          latency +
          ' · ' +
          String(h1.clients ?? 0) +
          ' / ' +
          String(h1.expected ?? 0) +
          ' клиентов · онлайн ' +
          String(h1.online ?? 0),
        rows: [
          {
            label: 'Адрес',
            value:
              String(h1.domain || '—') +
              ':' +
              String(h1.inbound?.port ?? '—'),
          },
          {
            label: 'Тип',
            value: 'STANDARD',
          },
          {
            label: 'H1Cloud API',
            value:
              (h1.apiOk ? '🟢 Доступен' : '🔴 Недоступен') +
              ' · ' +
              latency,
          },
          {
            label: 'Пользователи',
            value:
              String(h1.clients ?? 0) +
              ' / ' +
              String(h1.expected ?? 0),
          },
          {
            label: 'Inbound',
            value:
              (h1.inbound?.enabled ? '🟢 active · ' : '🔴 down · ') +
              inboundParts,
          },
          {
            label: 'Порт ' + String(h1.inbound?.port ?? '—'),
            value: h1.inbound?.enabled ? '🟢 open' : '🔴 closed',
          },
          {
            label: 'Подключения',
            value: String(h1.online ?? 0),
          },
          {
            label: 'Устройства',
            value:
              String(h1.devices ?? 0) +
              ' / ' +
              String(h1.deviceLimit ?? 0),
          },
          {
            label: 'Трафик',
            value: adminBytes(Number(h1.trafficBytes ?? 0)),
          },
          {
            label: 'Активные',
            value: String(h1.active ?? 0),
          },
          {
            label: 'Истекли / заблокированы',
            value:
              String(h1.expired ?? 0) +
              ' / ' +
              String(h1.banned ?? 0),
          },
          {
            label: 'Ближайшее окончание',
            value: nearestExpiry,
          },
          {
            label: 'Транспорт',
            value: String(h1.transportMode || '—').toUpperCase(),
          },
          {
            label: 'Выходной маршрут',
            value: String(h1.egressMode || '—'),
          },
          {
            label: 'Reality',
            value: h1.realityEnabled ? '🟢 Включён' : '🔴 Выключен',
          },
          {
            label: 'Версия панели',
            value: String(h1.version || '—'),
          },
          {
            label: 'Синхронизация',
            value: synchronized ? '🟢 OK' : '🟡 Несоответствие',
          },
        ],
      });
    }

    $('admin-updated').textContent = data.generatedAt
      ? 'Обновлено: ' +
        new Date(data.generatedAt).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '';
  }

  async function loadAdminDashboard() {
    if (!cabinet?.isAdmin) return toast('Нет доступа');
    const button = $('btn-admin-refresh');
    button.disabled = true;
    button.textContent = 'Обновление...';

    try {
      const res = await fetch(`${API_BASE}/api/webapp/admin/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: getInitData() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Ошибка ' + res.status);
      renderAdminDashboard(data);
      tg?.HapticFeedback?.notificationOccurred?.('success');
    } catch (error) {
      toast(error.message || 'Не удалось загрузить Admin Dashboard');
    } finally {
      button.disabled = false;
      button.textContent = '🔄 Обновить';
    }
  }

  async function load() {
    $('error-screen').classList.add('hidden');
    const initData = getInitData();
    if (!initData) {
      $('error-text').textContent = 'Откройте приложение из Telegram-бота';
      $('error-screen').classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/webapp/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Ошибка ' + res.status);
      }
      render(await res.json());
      showScreen('home');
    } catch (e) {
      $('error-text').textContent = e.message || 'Ошибка загрузки';
      $('error-screen').classList.remove('hidden');
    }
  }

  let manualPayment = null;
  let selectedProof = null;

  function setPurchaseStep(step) {
    ['bank', 'details', 'success'].forEach((name) => {
      $('purchase-step-' + name).classList.toggle('hidden', name !== step);
    });
  }

  function closePurchaseModal() {
    $('purchase-modal').classList.add('hidden');
    document.body.classList.remove('admin-modal-open');
    manualPayment = null;
    selectedProof = null;
    $('purchase-proof').value = '';
    $('purchase-proof-name').textContent = 'JPEG, PNG, WebP или PDF · до 10 МБ';
  }

  function openPurchaseModal(plan = 'STANDARD') {
    if (plan === 'PREMIUM') {
      return toast('Премиум временно недоступен');
    }

    const active = cabinet?.subscriptionState === 'ACTIVE';
    const expired = cabinet?.subscriptionState === 'EXPIRED';

    if (active && cabinet?.subscription?.plan === 'PREMIUM') {
      return toast('Продление Премиум временно недоступно');
    }

    $('purchase-modal-title').textContent = active
      ? 'Продлить подписку'
      : 'Купить подписку';

    $('purchase-modal-description').textContent = active
      ? 'После подтверждения оплаты к текущему сроку добавится 30 дней.'
      : expired
        ? 'После подтверждения оплаты доступ восстановится с прежней ссылкой.'
        : 'После подтверждения оплаты подписка будет активирована.';

    manualPayment = null;
    selectedProof = null;
    $('purchase-proof').value = '';
    setPurchaseStep('bank');
    $('purchase-modal').classList.remove('hidden');
    document.body.classList.add('admin-modal-open');
    tg?.HapticFeedback?.selectionChanged?.();
  }

  async function startManualPayment(bank) {
    const buttons = document.querySelectorAll('[data-purchase-bank]');
    buttons.forEach((button) => (button.disabled = true));

    try {
      const response = await fetch(API_BASE + '/api/webapp/manual-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: getInitData(),
          plan: 'STANDARD',
          bank,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || 'Не удалось создать платёж');
      }

      manualPayment = data;
      $('purchase-bank-name').textContent = data.bankName || '—';
      $('purchase-amount').textContent = String(data.amountRub ?? 300) + ' ₽';
      $('purchase-phone').textContent = data.phone || '—';
      $('purchase-recipient').textContent = data.recipient || '—';
      $('purchase-proof-name').textContent = 'JPEG, PNG, WebP или PDF · до 10 МБ';
      setPurchaseStep('details');
      tg?.HapticFeedback?.notificationOccurred?.('success');
    } catch (error) {
      toast(error.message || 'Ошибка создания платежа');
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  }

  async function submitManualProof() {
    if (!manualPayment?.paymentId) {
      return toast('Сначала создайте заявку');
    }

    if (!selectedProof) {
      return toast('Выберите чек');
    }

    if (selectedProof.size > 10 * 1024 * 1024) {
      return toast('Файл больше 10 МБ');
    }

    const button = $('purchase-submit-proof');
    button.disabled = true;
    button.textContent = 'Отправляем чек...';

    try {
      const form = new FormData();
      form.append('initData', getInitData());
      form.append('proof', selectedProof);

      const response = await fetch(
        API_BASE +
          '/api/webapp/manual-payment/' +
          encodeURIComponent(manualPayment.paymentId) +
          '/proof',
        {
          method: 'POST',
          body: form,
        },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || 'Не удалось отправить чек');
      }

      setPurchaseStep('success');
      tg?.HapticFeedback?.notificationOccurred?.('success');
    } catch (error) {
      toast(error.message || 'Ошибка отправки чека');
    } finally {
      button.disabled = false;
      button.textContent = '✅ Отправить чек на проверку';
    }
  }
  function copySub() {
    const url = cabinet?.subscription?.subUrl;
    if (url) copyText(url);
    else {
      toast(cabinet?.subscriptionState === 'EXPIRED' ? 'Подписка истекла' : 'Сначала оформите подписку');
      showScreen('sub');
    }
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => showScreen(t.dataset.tab);
  });
  document.querySelectorAll('[data-back]').forEach((b) => {
    b.onclick = () => showScreen(b.dataset.back);
  });

  $('btn-details').onclick = () => showScreen('servers');
  $('btn-renew').onclick = () => openPurchaseModal('STANDARD');
  $('btn-copy-sub').onclick = copySub;
  $('btn-copy-sub-top').onclick = copySub;
  $('btn-add-device').onclick = () => showScreen('servers');

  document.querySelectorAll('.plan').forEach((row) => {
    row.onclick = () => openPurchaseModal(row.dataset.plan);
  });

  $('menu-promo').onclick = () => showScreen('promo');
  $('menu-ref').onclick = () => showScreen('ref');
  $('menu-admin').onclick = () => {
    showScreen('admin');
    loadAdminDashboard();
  };
  $('btn-admin-refresh').onclick = loadAdminDashboard;
  $('admin-modal-close').onclick = closeAdminNodeModal;
  $('admin-node-modal').onclick = (event) => {
    if (event.target === $('admin-node-modal')) closeAdminNodeModal();
  };

  $('purchase-modal-close').onclick = closePurchaseModal;
  $('purchase-cancel').onclick = closePurchaseModal;
  $('purchase-done').onclick = closePurchaseModal;
  $('purchase-copy-phone').onclick = () => {
    const phone = manualPayment?.phone;
    if (phone) copyText(phone);
  };
  document.querySelectorAll('[data-purchase-bank]').forEach((button) => {
    button.onclick = () => startManualPayment(button.dataset.purchaseBank);
  });
  $('purchase-proof').onchange = (event) => {
    selectedProof = event.target.files?.[0] || null;
    $('purchase-proof-name').textContent = selectedProof
      ? selectedProof.name
      : 'JPEG, PNG, WebP или PDF · до 10 МБ';
  };
  $('purchase-submit-proof').onclick = submitManualProof;
  $('purchase-modal').onclick = (event) => {
    if (event.target === $('purchase-modal')) closePurchaseModal();
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAdminNodeModal();
      closePurchaseModal();
    }
  });
  $('btn-copy-ref').onclick = () => {
    if (cabinet?.referralLink) copyText(cabinet.referralLink);
  };
  $('btn-apply-promo').onclick = () => {
    if (!$('promo-input').value.trim()) return toast('Введите промокод');
    toast('Промокоды скоро будут доступны');
  };

  $('btn-retry').onclick = load;
  initBannerCarousel();
  load();
})();
