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

 /* ===== THEME SYSTEM START ===== */

 const THEME_STORAGE_KEY = '4steps-theme';

 const THEME_NAMES = {
 gold: 'Золотой',
 blue: 'Синий',
 purple: 'Фиолетовый',
 green: 'Зелёный',
 red: 'Красный',
 cyan: 'Бирюзовый',
 };

 function setTheme(theme, save = true) {
 const selected =
 Object.prototype.hasOwnProperty.call(
 THEME_NAMES,
 theme,
 )
 ? theme
 : 'gold';

 document.documentElement.dataset.theme =
 selected;

 if (save) {
 try {
 localStorage.setItem(
 THEME_STORAGE_KEY,
 selected,
 );
 } catch (_) {}
 }

 document
 .querySelectorAll('[data-theme-value]')
 .forEach((button) => {
 button.classList.toggle(
 'active',
 button.dataset.themeValue === selected,
 );
 });

 const current =
 $('settings-current-theme');

 if (current) {
 current.textContent =
 THEME_NAMES[selected];
 }
 }

 function loadTheme() {
 let saved = 'gold';

 try {
 saved =
 localStorage.getItem(
 THEME_STORAGE_KEY,
 ) || 'gold';
 } catch (_) {}

 setTheme(saved, false);
 }

 loadTheme();

 /* ===== THEME SYSTEM END ===== */

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
 const main = [
 'home',
 'servers',
 'devices',
 'sub',
 'profile',
 ];

 const target = $(`screen-${name}`);

 document
 .querySelectorAll('.screen')
 .forEach((screen) => {
 screen.classList.add('hidden');
 });

 if (!target) {
 console.error('Screen not found:', name);
 return;
 }

 target.classList.remove('hidden');

 document
 .querySelectorAll('.tab')
 .forEach((tab) => {
 tab.classList.toggle(
 'active',
 tab.dataset.tab === name,
 );
 });

 if ($('tabbar')) {
 $('tabbar').style.display =
 main.includes(name)
 ? 'flex'
 : 'none';
 }

 window.scrollTo(0, 0);
 }

 let notifications = [];

 function updateNotificationBadge() {
 const badge = $('notification-badge');
 if (!badge) return;

 const unread = notifications.filter((item) => !item.readAt).length;

 badge.textContent = unread > 99 ? '99+' : String(unread);
 badge.classList.toggle('hidden', unread === 0);
 }

 function renderNotifications() {
 const list = $('notifications-list');
 if (!list) return;

 if (!notifications.length) {
 list.innerHTML = `
 <div class="notifications-empty">
 У вас пока нет уведомлений
 </div>
 `;
 updateNotificationBadge();
 return;
 }

 list.innerHTML = '';

 notifications.forEach((item) => {
 const button = document.createElement('button');
 button.type = 'button';
 button.className =
 'notification-item' + (item.readAt ? ' is-read' : ' is-unread');

 const title = document.createElement('strong');
 title.textContent = item.title || 'Уведомление';

 const arrow = document.createElement('span');
 arrow.className = 'notification-item-arrow';
 arrow.textContent = '›';

 button.appendChild(title);
 button.appendChild(arrow);

 button.onclick = () => openNotification(item);

 list.appendChild(button);
 });

 updateNotificationBadge();
 }

 function openNotification(item) {
 const modal = $('notification-modal');
 if (!modal) return;

 $('notification-modal-title').textContent =
 item.title || 'Уведомление';

 $('notification-modal-body').textContent =
 item.body || '';

 modal.dataset.notificationId = item.id || '';
 modal.classList.remove('hidden');

 document.body.classList.add('notification-modal-open');

 if (!item.readAt) {
 markNotificationRead(item);
 }
 }

 function closeNotification() {
 const modal = $('notification-modal');
 if (!modal) return;

 modal.classList.add('hidden');
 modal.dataset.notificationId = '';

 document.body.classList.remove('notification-modal-open');
 }

 async function markNotificationRead(item) {
 const initData = getInitData();

 if (!initData || !item?.id) return;

 try {
 const response = await fetch(
 API_BASE +
 '/api/webapp/notifications/' +
 encodeURIComponent(item.id) +
 '/read',
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({ initData }),
 },
 );

 if (!response.ok) return;

 item.readAt = new Date().toISOString();

 renderNotifications();
 } catch (_) {
 // Не закрываем уведомление из-за сетевой ошибки.
 }
 }

 async function loadNotifications() {
 const initData = getInitData();
 const list = $('notifications-list');

 if (!initData) {
 if (list) {
 list.innerHTML = `
 <div class="notifications-empty">
 Откройте приложение из Telegram-бота
 </div>
 `;
 }
 return;
 }

 if (list) {
 list.innerHTML = `
 <div class="notifications-empty">
 Загрузка уведомлений...
 </div>
 `;
 }

 try {
 const response = await fetch(
 API_BASE + '/api/webapp/notifications',
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({ initData }),
 },
 );

 const data = await response.json().catch(() => ({}));

 if (!response.ok) {
 throw new Error(
 data.message || 'Не удалось загрузить уведомления',
 );
 }

 notifications = Array.isArray(data)
 ? data
 : Array.isArray(data.notifications)
 ? data.notifications
 : [];

 renderNotifications();
 } catch (error) {
 if (list) {
 list.innerHTML = `
 <div class="notifications-empty">
 Не удалось загрузить уведомления
 </div>
 `;
 }

 console.error('Notifications load failed:', error);
 }
 }

 $('btn-notifications').onclick = async () => {
 showScreen('notifications');
 await loadNotifications();
 };

 $('notification-modal-close').onclick = closeNotification;
 $('notification-modal-done').onclick = closeNotification;

 $('notification-modal').addEventListener('click', (event) => {
 if (event.target === $('notification-modal')) {
 closeNotification();
 }
 });

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

 function renderProfileAvatar(
   name,
   avatarUrl,
 ) {
   const avatar = $('avatar');

   if (!avatar) return;

   avatar.replaceChildren();

   avatar.classList.remove(
     'has-image',
     'is-uploading',
   );

   if (avatarUrl) {
     const image =
       document.createElement('img');

     image.src = avatarUrl;
     image.alt = '';
     image.className =
       'profile-avatar-image';

     image.addEventListener(
       'error',
       () => {
         avatar.replaceChildren();
         avatar.textContent =
           (name?.[0] || '?')
             .toUpperCase();
         avatar.classList.remove(
           'has-image',
         );
       },
       { once: true },
     );

     avatar.appendChild(image);

     avatar.classList.add(
       'has-image',
     );

     return;
   }

   avatar.textContent =
     (name?.[0] || '?')
       .toUpperCase();
 }


 async function loadNetworkStatus() {
  const initData = getInitData();

  if (!initData) return;

  try {
    const res = await fetch(
      `${API_BASE}/api/webapp/network-status`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          initData,
        }),
      },
    );

    const network =
      await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        network.message ||
        `Ошибка ${res.status}`,
      );
    }

    const networkBox =
      $('network-status');

    const networkTitle =
      $('network-status-title');

    const networkText =
      $('network-status-text');

    const networkCount =
      $('network-status-count');

    if (
      !networkBox ||
      !networkTitle ||
      !networkText ||
      !networkCount
    ) {
      return;
    }

    const state =
      String(
        network.status || 'UNKNOWN',
      ).toUpperCase();

    networkBox.className =
      'network-status network-status-' +
      state.toLowerCase();

    if (state === 'OK') {
      networkTitle.textContent =
        'Сеть работает';
    } else if (state === 'DEGRADED') {
      networkTitle.textContent =
        'Есть ограничения';
    } else if (state === 'DOWN') {
      networkTitle.textContent =
        'Сеть недоступна';
    } else {
      networkTitle.textContent =
        'Статус сети неизвестен';
    }

    networkText.textContent =
      network.message ||
      'Статус сети временно недоступен';

    networkCount.textContent =
      Number(network.total) > 0
        ? String(network.available ?? 0) +
          '/' +
          String(network.total)
        : '—';

    if (cabinet) {
      cabinet.networkStatus = network;
    }
  } catch (error) {
    console.warn(
      'Network status load failed:',
      error,
    );
  }
}


function render(data) {
 cabinet = data;
 const name = data.user?.firstName || data.user?.username || 'друг';
 $('greet-name').textContent = name;
 $('user-name').textContent = name;
 renderProfileAvatar(
    name,
    data.user?.avatarUrl,
  );
 $('user-meta').textContent = data.user?.username
 ? `@${data.user.username}`
 : `ID: ${data.user?.id?.slice?.(-6) || '—'}`;
 $('ref-link').textContent = data.referralLink || '—';

 if ($('ref-count')) {
   $('ref-count').textContent =
     String(Number(data.referralCount || 0));
 }
 $('menu-admin').style.display =
 data.isAdmin ? '' : 'none';

 if ($('profile-admin-btn')) {
 $('profile-admin-btn').style.display =
 data.isAdmin ? '' : 'none';
 }

 if ($('profile-generate-promo-btn')) {
 $('profile-generate-promo-btn').style.display =
 data.isAdmin ? '' : 'none';
 }

 const network = data.networkStatus || {
 status: 'UNKNOWN',
 available: 0,
 total: 0,
 message: 'Статус сети временно недоступен',
 };

 const networkBox = $('network-status');
 const networkTitle = $('network-status-title');
 const networkText = $('network-status-text');
 const networkCount = $('network-status-count');

 if (networkBox && networkTitle && networkText && networkCount) {
 const networkState = String(network.status || 'UNKNOWN').toUpperCase();

 networkBox.className =
 'network-status network-status-' + networkState.toLowerCase();

 if (networkState === 'OK') {
 networkTitle.textContent = 'Сеть работает';
 } else if (networkState === 'DEGRADED') {
 networkTitle.textContent = 'Есть ограничения';
 } else if (networkState === 'DOWN') {
 networkTitle.textContent = 'Сеть недоступна';
 } else {
 networkTitle.textContent = 'Статус сети неизвестен';
 }

 networkText.textContent =
 network.message || 'Статус сети временно недоступен';

 networkCount.textContent =
 Number(network.total) > 0
 ? String(network.available ?? 0) + '/' + String(network.total)
 : '—';
 }

 const sub = data.subscription;
 const state = data.subscriptionState || (sub ? 'ACTIVE' : 'NONE');
 const deviceLimit = data.deviceLimit ?? 1;
 const deviceUsed = data.deviceUsed ?? 0;
 const left = data.daysLeft ?? (sub ? daysLeft(sub.expiresAt) : 0);
 const subDays = $('days-num')?.closest('.sub-days');

 if (state === 'ACTIVE' && sub) {
 const planName = 'Стандарт';

 if (subDays) subDays.style.display = '';
 $('greet-status').textContent = 'Ваш доступ активен';
 $('greet-status').className = 'hello-sub on';

 $('status-dot').className =
 data.vpnConnected
 ? 'status-dot connected'
 : 'status-dot disconnected';

 $('hero-title').textContent = 'Подписка активна';
 $('hero-sub').textContent = sub.isTrial ? 'Пробный период · вы в безопасности' : 'Вы в безопасности';
 $('btn-renew').textContent = 'Продлить подписку ›';

 $('stat-days').textContent = String(left);
 $('stat-days-bar').style.width = Math.min(100, Math.round((left / 30) * 100)) + '%';
 $('stat-devices').textContent = `${deviceUsed} из ${deviceLimit}`;
 $('stat-net').textContent = planName;
 $('stat-net-lbl').textContent = 'тариф';

 $('sub-url').textContent = sub.subUrl;

 $('sub-plan-name').textContent = planName;
 $('sub-plan-desc').textContent = 'Доступ ко всем доступным серверам';
 $('sub-badge').hidden = false;
 $('days-num').textContent = pluralDays(left);
 $('days-until').textContent = 'До ' + formatDate(sub.expiresAt);
 $('progress-bar').style.width = Math.min(100, Math.round((left / 30) * 100)) + '%';

 $('ps-plan').textContent = planName;
 $('ps-devices').textContent = String(deviceUsed);

 if ($('profile-plan-badge')) {
 $('profile-plan-badge').textContent = planName;
 }

 if ($('profile-sub-status')) {
 $('profile-sub-status').textContent = 'Активна';
 }

 if ($('profile-devices-value')) {
 $('profile-devices-value').textContent =
 `${deviceUsed} / ${deviceLimit}`;
 }

 if ($('profile-expiry')) {
 $('profile-expiry').textContent =
 new Date(sub.expiresAt).toLocaleDateString(
 'ru-RU',
 {
 day: '2-digit',
 month: '2-digit',
 year: 'numeric',
 },
 );
 }

 if ($('profile-days-left')) {
 $('profile-days-left').textContent =
 `Осталось ${pluralDays(left)}`;
 }
 $('dev-count').textContent = `${deviceUsed} из ${deviceLimit}`;
 $('dev-avail').textContent =
 `Доступно ещё ${Math.max(0, deviceLimit - deviceUsed)}`;
 $('dev-bar').style.width = `${Math.min(100, Math.round((deviceUsed / Math.max(1, deviceLimit)) * 100))}%`;
 const device = data.device;

 if (device?.isActive) {
 $('btn-add-device').style.display = 'none';

 const deviceName = device.name || 'Моё устройство';
 const devicePlatform = device.platform
 ? ' · ' + device.platform
 : '';

 $('dev-list').innerHTML =
 '<div class="dev-item">' +
 '<div class="dev-item-ico">📱</div>' +
 '<div><div class="dev-item-name"></div>' +
 '<div class="dev-item-meta"></div></div>' +
 '<span class="dev-online">Активно</span></div>';

 const item = $('dev-list').querySelector('.dev-item');
 item.querySelector('.dev-item-name').textContent = deviceName;
 item.querySelector('.dev-item-meta').textContent =
 'Привязано' + devicePlatform + ' · ' + planName;
 } else {
 $('btn-add-device').style.display = '';

 $('dev-list').innerHTML =
 '<div class="dev-empty" id="dev-empty">' +
 'Устройство ещё не привязано.<br/>' +
 'Нажмите «Привязать устройство» ниже.' +
 '</div>';
 }

 return;
 }

 $('greet-status').className = 'hello-sub';
 $('status-dot').className = 'status-dot';
 $('stat-days').textContent = '0';
 $('stat-days-bar').style.width = '0%';
 $('stat-devices').textContent = `0 из ${deviceLimit}`;
 $('stat-net').textContent = '—';
 $('stat-net-lbl').textContent = 'тариф';
 $('sub-badge').hidden = true;
 $('days-num').textContent = '—';
 $('days-until').textContent = '';
 $('progress-bar').style.width = '0%';
 $('ps-plan').textContent = '—';
 $('ps-devices').textContent = '0';
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
 $('sub-plan-name').textContent = 'Подписка истекла';
 $('sub-plan-desc').textContent = 'Продлите тариф, чтобы снова подключиться';
 $('btn-renew').textContent = 'Продлить подписку ›';
 $('dev-list').innerHTML =
 '<div class="dev-empty" id="dev-empty">Подписка истекла.<br/>После продления доступ на устройстве восстановится.</div>';
 return;
 }

 if (subDays) subDays.style.display = 'none';
 $('greet-status').textContent = 'Подписка не оформлена';
 $('hero-title').textContent = 'Подписка не активна';
 $('hero-sub').textContent = 'Оформите тариф, чтобы начать';
 $('sub-url').textContent = 'Нет активной подписки';
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
 CH1: { flag: '🇨🇭', name: 'Switzerland' },
 SE1: { flag: '🇸🇪', name: 'Sweden' },
 NL1: { flag: '🇳🇱', name: 'Netherlands' },
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

 async function createAdminNotification() {
 if (!cabinet?.isAdmin) {
 return toast('Нет доступа');
 }

 const titleInput = $('admin-notification-title');
 const bodyInput = $('admin-notification-body');
 const button = $('btn-admin-notification-send');

 const title = titleInput.value.trim();
 const body = bodyInput.value.trim();

 if (!title) {
 titleInput.focus();
 return toast('Введите заголовок');
 }

 if (!body) {
 bodyInput.focus();
 return toast('Введите текст уведомления');
 }

 const originalText = button.textContent;

 button.disabled = true;
 button.textContent = 'Отправка...';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/notifications`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: tg.initData,
 title,
 body,
 }),
 },
 );

 const data = await res.json().catch(() => ({}));

 if (!res.ok) {
 throw new Error(
 data.message || `Ошибка ${res.status}`,
 );
 }

 titleInput.value = '';
 bodyInput.value = '';

 await loadNotifications();

 toast('Уведомление отправлено');
 } catch (error) {
 console.error(
 'Admin notification create failed:',
 error,
 );

 toast(
 error.message ||
 'Не удалось отправить уведомление',
 );
 } finally {
 button.disabled = false;
 button.textContent = originalText;
 }
 }


 function renderAdminTicketStatusControls(status) {
 document
 .querySelectorAll(
 '.admin-ticket-status-btn',
 )
 .forEach((button) => {
 button.classList.toggle(
 'active',
 button.dataset.status === status,
 );
 });
}


async function updateAdminTicketStatus(status) {
 const ticket =
 window.__activeAdminSupportTicket;

 if (ticket == null) {
 return toast(
 'Не удалось определить обращение',
 );
 }

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/support/tickets/${ticket.id}/status`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 status,
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 ticket.status = status;

 renderAdminTicketStatusControls(
 status,
 );

 const statusEl =
 $('admin-ticket-detail-status');

 const map = {
 NEW: 'Новое',
 IN_PROGRESS: 'В работе',
 RESOLVED: 'Решено',
 };

 statusEl.className =
 'support-ticket-status status-' +
 String(status)
 .toLowerCase()
 .replace('_', '-');

 statusEl.textContent =
 map[status] || status;

 await loadAdminTickets();

 const updatedTicket =
 window.__adminSupportTickets
 ?.find(
 item => item.id === ticket.id,
 );

 if (updatedTicket) {
 window.__activeAdminSupportTicket =
 updatedTicket;
 }

 toast('Статус обновлён');
 } catch (error) {
 toast(
 error.message ||
 'Не удалось обновить статус',
 );
 }
}


function openAdminSupportTicket(ticket) {
 const dialog =
 $('admin-ticket-dialog');

 window.__activeAdminSupportTicket =
 ticket;

 if (dialog == null) {
 console.error(
 'admin-ticket-dialog not found',
 );
 return;
 }

 $('admin-ticket-detail-title').textContent =
 ticket.title || 'Обращение';

 const firstName =
 ticket.user?.firstName || '';

 const lastName =
 ticket.user?.lastName || '';

 const username =
 ticket.user?.username
 ? `@${ticket.user.username}`
 : '';

 const displayName =
 [firstName, lastName]
 .filter(Boolean)
 .join(' ');

 $('admin-ticket-detail-user').textContent =
 displayName ||
 username ||
 `Telegram ID: ${ticket.user?.telegramId || '—'}`;

 $('admin-ticket-detail-date').textContent =
 ticket.createdAt
 ? new Date(ticket.createdAt)
   .toLocaleString('ru-RU')
 : '';

 const status =
 $('admin-ticket-detail-status');

 const statusMap = {
 NEW: 'Новое',
 IN_PROGRESS: 'В работе',
 RESOLVED: 'Решено',
 };

 status.className =
 'support-ticket-status status-' +
 String(ticket.status || 'NEW')
 .toLowerCase()
 .replace('_', '-');

 status.textContent =
 statusMap[ticket.status] ||
 ticket.status ||
 '—';

 renderAdminTicketStatusControls(
 ticket.status,
 );

 dialog.replaceChildren();

 const item =
 document.createElement('div');

 item.className =
 'support-message support-message-admin';

 const label =
 document.createElement('small');

 label.textContent =
 'Пользователь';

 const text =
 document.createElement('p');

 text.textContent =
 ticket.body || '';

 const date =
 document.createElement('time');

 date.textContent =
 ticket.createdAt
 ? new Date(ticket.createdAt)
   .toLocaleString('ru-RU')
 : '';

 item.append(
 label,
 text,
 date,
 );

 dialog.append(item);

 const messages =
 Array.isArray(ticket.messages)
 ? ticket.messages
 : [];

 messages.forEach((message) => {
 const messageItem =
 document.createElement('div');

 messageItem.className =
 message.author === 'ADMIN'
 ? 'support-message support-message-user'
 : 'support-message support-message-admin';

 const messageLabel =
 document.createElement('small');

 messageLabel.textContent =
 message.author === 'ADMIN'
 ? 'Администратор'
 : 'Пользователь';

 const messageText =
 document.createElement('p');

 messageText.textContent =
 message.body || '';

 const messageDate =
 document.createElement('time');

 messageDate.textContent =
 message.createdAt
 ? new Date(message.createdAt)
   .toLocaleString('ru-RU')
 : '';

 messageItem.append(
 messageLabel,
 messageText,
 messageDate,
 );

 dialog.append(messageItem);
 });

 const attachment =
 $('admin-ticket-detail-attachment');

 if (ticket.attachmentUrl) {
 attachment.classList.remove('hidden');

 attachment.onclick = () => {
 const url =
 `${API_BASE}${ticket.attachmentUrl}`;

 if (tg?.openLink) {
 tg.openLink(url);
 } else {
 window.open(
 url,
 '_blank',
 'noopener',
 );
 }
 };
 } else {
 attachment.classList.add('hidden');
 attachment.onclick = null;
 }

 const replyInput =
 $('admin-ticket-reply-body');

 if (replyInput) {
 replyInput.value = '';
 }

 showScreen('admin-ticket-detail');
}


async function submitAdminSupportReply() {
 const ticket =
 window.__activeAdminSupportTicket;

 const input =
 $('admin-ticket-reply-body');

 const button =
 $('btn-admin-ticket-reply');

 const body =
 input?.value?.trim() || '';

 if (ticket == null) {
 return toast(
 'Не удалось определить обращение',
 );
 }

 if (body.length === 0) {
 input?.focus();

 return toast(
 'Введите ответ',
 );
 }

 const originalText =
 button.textContent;

 button.disabled = true;
 button.textContent = 'Отправка...';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/support/tickets/${ticket.id}/reply`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 body,
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 input.value = '';

 toast(
 'Ответ отправлен',
 );

 await loadAdminTickets();

 const updatedTicket =
 window.__adminSupportTickets
 ?.find(
 item => item.id === ticket.id,
 );

 if (updatedTicket) {
 openAdminSupportTicket(
 updatedTicket,
 );
 }
 } catch (error) {
 toast(
 error.message ||
 'Не удалось отправить ответ',
 );
 } finally {
 button.disabled = false;
 button.textContent = originalText;
 }
}


async function loadAdminTickets() {
 const list = $('admin-ticket-list');

 if (list == null) {
 console.error('admin-ticket-list not found');
 return;
 }

 list.innerHTML =
 '<div class="admin-tickets-empty"><strong>Загрузка...</strong></div>';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/support/tickets`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message || `Ошибка ${res.status}`,
 );
 }

 const tickets =
 Array.isArray(data.tickets)
 ? data.tickets
 : [];

 window.__adminSupportTickets = tickets;

 if (tickets.length === 0) {
 list.innerHTML =
 '<div class="admin-tickets-empty"><strong>Обращений пока нет</strong></div>';
 return;
 }

 list.replaceChildren();

 const statusMap = {
 NEW: 'Новое',
 IN_PROGRESS: 'В работе',
 RESOLVED: 'Решено',
 };

 tickets.forEach((ticket) => {
 const card =
 document.createElement('div');

 card.className =
 'admin-ticket-card';

 card.tabIndex = 0;

 card.onclick = () => {
 openAdminSupportTicket(ticket);
 };

 const top =
 document.createElement('div');

 top.className =
 'admin-ticket-top';

 const left =
 document.createElement('div');

 const title =
 document.createElement('strong');

 title.textContent =
 ticket.title || 'Обращение';

 const user =
 document.createElement('small');

 const firstName =
 ticket.user?.firstName || '';

 const lastName =
 ticket.user?.lastName || '';

 const username =
 ticket.user?.username
 ? `@${ticket.user.username}`
 : '';

 const displayName =
 [firstName, lastName]
 .filter(Boolean)
 .join(' ');

 user.textContent =
 displayName ||
 username ||
 `Telegram ID: ${ticket.user?.telegramId || '—'}`;

 left.append(
 title,
 user,
 );

 const status =
 document.createElement('span');

 status.className =
 'support-ticket-status status-' +
 String(ticket.status || 'NEW')
 .toLowerCase()
 .replace('_', '-');

 status.textContent =
 statusMap[ticket.status] ||
 ticket.status ||
 '—';

 top.append(
 left,
 status,
 );

 const body =
 document.createElement('p');

 body.textContent =
 ticket.body || '';

 const date =
 document.createElement('time');

 date.textContent =
 ticket.createdAt
 ? new Date(ticket.createdAt)
   .toLocaleString('ru-RU')
 : '';

 card.append(
 top,
 body,
 date,
 );

 list.append(card);
 });
 } catch (error) {
 console.error(
 'Admin tickets load failed:',
 error,
 );

 list.innerHTML =
 '<div class="admin-tickets-empty"><strong>Не удалось загрузить обращения</strong></div>';
 }
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

 let vpnStatusTimer = null;

 function applyVpnStatus(data) {
 const dot = $('status-dot');

 if (!dot) {
 return;
 }

 const active =
 data?.subscriptionState === 'ACTIVE' &&
 Boolean(data?.subscription);

 if (!active) {
 dot.className = 'status-dot';
 return;
 }

 dot.className =
 data.vpnConnected
 ? 'status-dot connected'
 : 'status-dot disconnected';
 }

 async function refreshVpnStatus() {
 if (document.hidden) {
 return;
 }

 const initData = getInitData();

 if (!initData) {
 return;
 }

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/me`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData,
 }),
 },
 );

 if (!res.ok) {
 return;
 }

 const data = await res.json();

 if (cabinet) {
 cabinet.vpnConnected =
 Boolean(data.vpnConnected);

 cabinet.subscriptionState =
 data.subscriptionState;

 cabinet.subscription =
 data.subscription;
 }

 applyVpnStatus(data);
 } catch (_) {
 // Не меняем текущий статус при временной ошибке сети.
 }
 }

 function startVpnStatusPolling() {
 if (vpnStatusTimer !== null) {
 return;
 }

 vpnStatusTimer = setInterval(
 () => {
 void refreshVpnStatus();
 },
 20_000,
 );
 }

 document.addEventListener(
 'visibilitychange',
 () => {
 if (!document.hidden) {
 void refreshVpnStatus();
 }
 },
 );

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
 const data = await res.json();

 render(data);
 applyVpnStatus(data);
 showScreen('home');

 startVpnStatusPolling();

 void loadNetworkStatus();
 void loadNotifications();
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
 selectedProof = null;

 $('purchase-proof').value = '';
 $('purchase-proof-name').textContent =
 'JPEG, PNG, WebP или PDF · до 10 МБ';

 showScreen('sub');
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
 showScreen('payment');
 tg?.HapticFeedback?.selectionChanged?.();
 }

 async function startManualPayment(bank) {
 const initData = getInitData();

 if (!initData) {
 return toast('Откройте приложение из Telegram-бота');
 }

 const buttons = document.querySelectorAll('[data-purchase-bank]');
 buttons.forEach((button) => (button.disabled = true));

 try {
 const response = await fetch(API_BASE + '/api/webapp/manual-payment', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 initData,
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
 const initData = getInitData();

 if (!initData) {
 return toast('Откройте приложение из Telegram-бота');
 }

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
 form.append('initData', initData);
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

 $('btn-details').onclick = () => {
 if (cabinet?.subscriptionState !== 'ACTIVE') {
 toast(
 cabinet?.subscriptionState === 'EXPIRED'
 ? 'Подписка истекла'
 : 'Сначала оформите подписку',
 );
 showScreen('sub');
 return;
 }

 showScreen('servers');
 };

 $('btn-renew').onclick = () => openPurchaseModal('STANDARD');
 $('btn-copy-sub').onclick = copySub;

 function openExternalAppLink(iosUrl, androidUrl, fallbackUrl = iosUrl) {
 const platform = String(tg?.platform || '').toLowerCase();

 const url =
 platform === 'android'
 ? androidUrl
 : platform === 'ios'
 ? iosUrl
 : fallbackUrl;

 if (tg?.openLink) {
 tg.openLink(url);
 } else {
 window.open(url, '_blank', 'noopener');
 }
 }

 $('btn-app-incy').onclick = () => {
 openExternalAppLink(
 'https://apps.apple.com/app/incy/id6756943388',
 'https://play.google.com/store/apps/details?id=llc.itdev.incy',
 );
 };

 $('btn-app-happ').onclick = () => {
 openExternalAppLink(
 'https://apps.apple.com/app/happ-proxy-utility/id6504287215',
 'https://play.google.com/store/apps/details?id=com.happproxy',
 'https://happ.info/',
 );
 };

 $('btn-app-v2raytun').onclick = () => {
 openExternalAppLink(
 'https://apps.apple.com/app/v2raytun/id6476628951',
 'https://play.google.com/store/apps/details?id=com.v2raytun.android',
 );
 };

 $('btn-app-hiddify').onclick = () => {
 openExternalAppLink(
 'https://hiddify.com/',
 'https://play.google.com/store/apps/details?id=app.hiddify.com',
 'https://hiddify.com/',
 );
 };

 $('btn-add-device').onclick = async () => {
 const button = $('btn-add-device');
 const initData = getInitData();

 if (!initData) {
 return toast('Откройте приложение из Telegram-бота');
 }

 if (!cabinet?.subscription) {
 toast('Сначала оформите подписку');
 showScreen('sub');
 return;
 }

 button.disabled = true;

 const originalHtml = button.innerHTML;
 button.textContent = 'Привязываем...';

 try {
 const response = await fetch(API_BASE + '/api/webapp/device/activate', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData,
 name: 'Моё устройство',
 platform: tg?.platform || null,
 }),
 });

 const data = await response.json().catch(() => ({}));

 if (!response.ok) {
 throw new Error(data.message || 'Не удалось привязать устройство');
 }

 tg?.HapticFeedback?.notificationOccurred?.('success');

 toast(
 data.created
 ? 'Устройство привязано'
 : 'Устройство уже привязано',
 );

 await load();
 } catch (error) {
 toast(error.message || 'Ошибка привязки устройства');
 } finally {
 button.disabled = false;
 button.innerHTML = originalHtml;
 }
 };

 document.querySelectorAll('.plan').forEach((row) => {
 row.onclick = () => openPurchaseModal(row.dataset.plan);
 });

 if ($('menu-promo')) {
 $('menu-promo').onclick = () => showScreen('promo');
 }
 if ($('menu-ref')) {
 $('menu-ref').onclick = () => showScreen('ref');
 }

 if ($('profile-promo-btn')) {
 $('profile-promo-btn').onclick =
 () => showScreen('promo');
 }

 if ($('profile-ref-btn')) {
 $('profile-ref-btn').onclick =
 () => showScreen('ref');
 }

 if ($('profile-ref-banner')) {
 $('profile-ref-banner').onclick =
 () => showScreen('ref');
 }

 if ($('profile-support-btn')) {
 $('profile-support-btn').onclick = async () => {
 showScreen('support');
 await loadSupportTickets();
 };
 }


 if ($('profile-notifications')) {
 $('profile-notifications').onclick = async () => {
 showScreen('notifications');
 await loadNotifications();
 };
 }
 $('menu-admin').onclick = () => {
 showScreen('admin');
 loadAdminDashboard();
 };

 if ($('profile-admin-btn')) {
 $('profile-admin-btn').onclick = () => {
 showScreen('admin');
 loadAdminDashboard();
 };
 }

 /* ===== PROFILE RUNTIME FIX ===== */

 if ($('profile-promo-btn')) {
 $('profile-promo-btn').onclick =
 () => showScreen('promo');
 }

 if ($('profile-ref-btn')) {
 $('profile-ref-btn').onclick =
 () => showScreen('ref');
 }

 if ($('profile-ref-banner')) {
 $('profile-ref-banner').onclick =
 () => showScreen('ref');
 }

 if ($('profile-notifications')) {
 $('profile-notifications').onclick = async () => {
 showScreen('notifications');
 await loadNotifications();
 };
 }

 if ($('profile-admin-btn')) {
 $('profile-admin-btn').onclick = () => {
 showScreen('admin');
 loadAdminDashboard();
 };
 }



 /* ===== PROFILE AVATAR START ===== */

  const avatarButton = $('avatar');
  const avatarInput = $('avatar-input');

  if (avatarButton && avatarInput) {

    avatarButton.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();

        avatarInput.value = '';
        avatarInput.click();

        tg?.HapticFeedback
          ?.selectionChanged?.();
      },
    );


    avatarInput.addEventListener(
      'change',
      async () => {
        const file =
          avatarInput.files?.[0];

        if (!file) return;

        const allowedTypes = new Set([
          'image/jpeg',
          'image/png',
          'image/webp',
        ]);

        if (!allowedTypes.has(file.type)) {
          toast(
            'Поддерживаются JPEG, PNG и WebP',
          );
          return;
        }

        if (file.size > 5 * 1024 * 1024) {
          toast(
            'Размер изображения не должен превышать 5 МБ',
          );
          return;
        }

        const initData = getInitData();

        if (!initData) {
          toast(
            'Не удалось подтвердить Telegram',
          );
          return;
        }

        const formData = new FormData();

        formData.append(
          'initData',
          initData,
        );

        formData.append(
          'avatar',
          file,
        );

        avatarButton.classList.add(
          'is-uploading',
        );

        avatarButton.disabled = true;

        try {
          const response = await fetch(
            API_BASE +
              '/api/webapp/avatar',
            {
              method: 'POST',
              body: formData,
            },
          );

          const data =
            await response.json()
              .catch(() => ({}));

          if (!response.ok) {
            throw new Error(
              data.message ||
              'Не удалось загрузить аватар',
            );
          }

          if (!data.avatarUrl) {
            throw new Error(
              'Сервер не вернул аватар',
            );
          }

          if (cabinet?.user) {
            cabinet.user.avatarUrl =
              data.avatarUrl;
          }

          const currentName =
            cabinet?.user?.firstName ||
            cabinet?.user?.username ||
            'друг';

          renderProfileAvatar(
            currentName,
            data.avatarUrl,
          );

          toast('Аватар обновлён');

          tg?.HapticFeedback
            ?.notificationOccurred?.(
              'success',
            );
        } catch (error) {
          console.error(
            'Avatar upload failed',
            error,
          );

          toast(
            error instanceof Error
              ? error.message
              : 'Не удалось загрузить аватар',
          );

          tg?.HapticFeedback
            ?.notificationOccurred?.(
              'error',
            );
        } finally {
          avatarButton.disabled = false;

          avatarButton.classList.remove(
            'is-uploading',
          );

          avatarInput.value = '';
        }
      },
    );

  }

  /* ===== PROFILE AVATAR END ===== */


/* ===== SETTINGS HANDLERS START ===== */

  const openSettings = () => {
    showScreen('settings');
  };

  if ($('profile-settings-btn')) {
    $('profile-settings-btn').onclick =
      openSettings;
  }

  if ($('profile-settings-card')) {
    $('profile-settings-card').onclick =
      openSettings;
  }


  // =====================================================
  // THEME PICKER
  // =====================================================

  const openThemePicker = () => {
    const modal = $('theme-modal');

    if (!modal) {
      toast('Не удалось открыть выбор темы');
      return;
    }

    setTheme(
      document.documentElement.dataset.theme ||
        'gold',
      false,
    );

    modal.classList.remove('hidden');

    modal.setAttribute(
      'aria-hidden',
      'false',
    );

    document.body.classList.add(
      'theme-modal-open',
    );
  };



  if ($('settings-theme-btn')) {
    $('settings-theme-btn').onclick =
      openThemePicker;
  }

  if ($('settings-notifications-btn')) {
    $('settings-notifications-btn').onclick =
      async () => {
        showScreen('notifications');
        await loadNotifications();
      };
  }

  if ($('settings-support-btn')) {
    $('settings-support-btn').onclick =
      async () => {
        showScreen('support');
        await loadSupportTickets();
      };
  }


  const closeThemePicker = () => {
    const modal = $('theme-modal');

    if (!modal) return;

    modal.classList.add('hidden');

    modal.setAttribute(
      'aria-hidden',
      'true',
    );

    document.body.classList.remove(
      'theme-modal-open',
    );
  };


  const themePickerButton =
    $('btn-theme-picker');

  if (themePickerButton) {
    themePickerButton.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();

        openThemePicker();

        tg?.HapticFeedback
          ?.selectionChanged?.();
      },
    );
  }


  const themeModalClose =
    $('theme-modal-close');

  if (themeModalClose) {
    themeModalClose.addEventListener(
      'click',
      closeThemePicker,
    );
  }


  const themeModalBackdrop =
    $('theme-modal-backdrop');

  if (themeModalBackdrop) {
    themeModalBackdrop.addEventListener(
      'click',
      closeThemePicker,
    );
  }


  document
    .querySelectorAll(
      '.theme-tile[data-theme-value]',
    )
    .forEach((button) => {

      button.addEventListener(
        'click',
        () => {

          setTheme(
            button.dataset.themeValue,
            true,
          );

          tg?.HapticFeedback
            ?.selectionChanged?.();

        },
      );

    });

  /* ===== SETTINGS HANDLERS END ===== */

 /* ===== ADMIN HUB NAVIGATION ===== */

 if ($('admin-open-active')) {
 $('admin-open-active').onclick = async () => {
 showScreen('admin-active');
 await loadAdminDashboard();
 };
 }

 if ($('admin-open-servers')) {
 $('admin-open-servers').onclick = async () => {
 showScreen('admin-servers');
 await loadAdminDashboard();
 };
 }

 if ($('admin-open-notification')) {
 $('admin-open-notification').onclick = () => {
 showScreen('admin-notification');
 };
 }

 if ($('admin-open-tickets')) {
 $('admin-open-tickets').onclick = async () => {
 showScreen('admin-tickets');
 await loadAdminTickets();
 };
 }

 /* ===== ADMIN HUB NAVIGATION END ===== */


 function supportStatusLabel(status) {
 const map = {
 NEW: 'Новое',
 IN_PROGRESS: 'В работе',
 RESOLVED: 'Решено',
 };

 return map[status] || status || '—';
 }


 function supportStatusClass(status) {
 return (
 'support-ticket-status status-' +
 String(status || 'NEW')
 .toLowerCase()
 .replace('_', '-')
 );
 }


 function supportDate(value) {
 if (value == null) return '';

 return new Date(value)
 .toLocaleString('ru-RU', {
 day: '2-digit',
 month: '2-digit',
 year: 'numeric',
 hour: '2-digit',
 minute: '2-digit',
 });
 }


 function openSupportTicket(ticket) {
 const screen = $('screen-support-ticket');
 const dialog = $('support-dialog');

 if (screen == null || dialog == null) return;

 screen.dataset.ticketId = ticket.id;

 $('support-detail-title').textContent =
 ticket.title || 'Обращение';

 $('support-detail-date').textContent =
 supportDate(ticket.createdAt);

 const status = $('support-detail-status');

 status.className =
 supportStatusClass(ticket.status);

 status.textContent =
 supportStatusLabel(ticket.status);

 dialog.replaceChildren();

 const addMessage = (
 author,
 body,
 createdAt,
 ) => {
 const item =
 document.createElement('div');

 item.className =
 author === 'ADMIN'
 ? 'support-message support-message-admin'
 : 'support-message support-message-user';

 const label =
 document.createElement('small');

 label.textContent =
 author === 'ADMIN'
 ? 'Поддержка'
 : 'Вы';

 const text =
 document.createElement('p');

 text.textContent = body || '';

 const date =
 document.createElement('time');

 date.textContent =
 supportDate(createdAt);

 item.append(
 label,
 text,
 date,
 );

 dialog.append(item);
 };

 addMessage(
 'USER',
 ticket.body,
 ticket.createdAt,
 );

 const messages =
 Array.isArray(ticket.messages)
 ? ticket.messages
 : [];

 messages.forEach((message) => {
 addMessage(
 message.author,
 message.body,
 message.createdAt,
 );
 });

 const attachment =
 $('support-detail-attachment');

 if (ticket.attachmentUrl) {
 attachment.classList.remove('hidden');

 attachment.onclick = () => {
 const url =
 `${API_BASE}${ticket.attachmentUrl}`;

 if (tg?.openLink) {
 tg.openLink(url);
 } else {
 window.open(
 url,
 '_blank',
 'noopener',
 );
 }
 };
 } else {
 attachment.classList.add('hidden');
 attachment.onclick = null;
 }

 const replyBox =
 $('support-reply-box');

 const closedBox =
 $('support-ticket-closed');

 if (ticket.status === 'RESOLVED') {
 replyBox?.classList.add('hidden');
 closedBox?.classList.remove('hidden');
 } else {
 replyBox?.classList.remove('hidden');
 closedBox?.classList.add('hidden');
 }

 $('support-reply-body').value = '';

 showScreen('support-ticket');

 setTimeout(() => {
 dialog.scrollTop =
 dialog.scrollHeight;
 }, 0);
 }


 async function submitSupportTicketReply() {
 const screen =
 $('screen-support-ticket');

 const input =
 $('support-reply-body');

 const button =
 $('btn-support-reply');

 const ticketId =
 screen?.dataset?.ticketId || '';

 const body =
 input?.value?.trim() || '';

 if (ticketId.length === 0) {
 return toast(
 'Не удалось определить обращение',
 );
 }

 if (body.length === 0) {
 input?.focus();
 return toast(
 'Введите сообщение',
 );
 }

 const originalText =
 button.textContent;

 button.disabled = true;
 button.textContent = 'Отправка...';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/support/tickets/${ticketId}/reply`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 body,
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 input.value = '';

 toast('Сообщение отправлено');

 await loadSupportTickets();

 const ticket =
 window.__supportTickets
 ?.find(
 item => item.id === ticketId,
 );

 if (ticket) {
 openSupportTicket(ticket);
 }
 } catch (error) {
 toast(
 error.message ||
 'Не удалось отправить сообщение',
 );
 } finally {
 button.disabled = false;
 button.textContent = originalText;
 }
 }


 async function loadSupportTickets() {
 const list = $('support-ticket-list');

 if (!list) return;

 list.innerHTML =
 '<div class="support-ticket-empty">Загрузка...</div>';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/support/tickets/me`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 }),
 },
 );

 const data = await res.json().catch(() => ({}));

 if (!res.ok) {
 throw new Error(
 data.message || `Ошибка ${res.status}`,
 );
 }

 const tickets =
 Array.isArray(data.tickets)
 ? data.tickets
 : [];

 window.__supportTickets = tickets;

 if (!tickets.length) {
 list.innerHTML =
 '<div class="support-ticket-empty">Обращений пока нет</div>';
 return;
 }

 list.replaceChildren();

 const statusMap = {
 NEW: 'Новое',
 IN_PROGRESS: 'В работе',
 RESOLVED: 'Решено',
 };

 tickets.forEach((ticket) => {
 const card = document.createElement('div');
 card.className = 'support-ticket-card';
 card.tabIndex = 0;

 card.onclick = (event) => {
 if (
 event.target.closest(
 '.support-ticket-attachment',
 )
 ) {
 return;
 }

 openSupportTicket(ticket);
 };

 const top = document.createElement('div');
 top.className = 'support-ticket-top';

 const title = document.createElement('strong');
 title.textContent =
 ticket.title || 'Обращение';

 const status = document.createElement('span');
 status.className =
 'support-ticket-status status-' +
 String(ticket.status || 'NEW')
 .toLowerCase()
 .replace('_', '-');

 status.textContent =
 statusMap[ticket.status] ||
 ticket.status ||
 '—';

 top.append(title, status);

 const body = document.createElement('p');
 body.textContent =
 ticket.body || '';

 const meta = document.createElement('small');

 meta.textContent =
 ticket.createdAt
 ? new Date(ticket.createdAt)
 .toLocaleString('ru-RU', {
 day: '2-digit',
 month: '2-digit',
 year: 'numeric',
 hour: '2-digit',
 minute: '2-digit',
 })
 : '';

 card.append(
 top,
 body,
 meta,
 );

 if (ticket.attachmentUrl) {
 const link = document.createElement('button');

 link.type = 'button';
 link.className = 'support-ticket-attachment';
 link.textContent = '📎 Открыть вложение';

 link.onclick = () => {
 const url =
 `${API_BASE}${ticket.attachmentUrl}`;

 if (tg?.openLink) {
 tg.openLink(url);
 } else {
 window.open(
 url,
 '_blank',
 'noopener',
 );
 }
 };

 card.append(link);
 }

 list.append(card);
 });
 } catch (error) {
 list.innerHTML =
 '<div class="support-ticket-empty">Не удалось загрузить обращения</div>';

 console.error(
 'Support tickets load failed:',
 error,
 );
 }
 }


 async function submitSupportTicket() {
 const titleInput = $('support-title');
 const bodyInput = $('support-body');
 const fileInput = $('support-attachment');
 const button = $('btn-support-submit');

 const title =
 titleInput?.value?.trim() || '';

 const body =
 bodyInput?.value?.trim() || '';

 const file =
 fileInput?.files?.[0] || null;

 if (!title) {
 titleInput?.focus();
 return toast('Введите тему обращения');
 }

 if (!body) {
 bodyInput?.focus();
 return toast('Опишите проблему');
 }

 if (
 file &&
 file.size > 10 * 1024 * 1024
 ) {
 return toast(
 'Файл должен быть не больше 10 МБ',
 );
 }

 const form = new FormData();

 form.append(
 'initData',
 getInitData(),
 );

 form.append(
 'title',
 title,
 );

 form.append(
 'body',
 body,
 );

 if (file) {
 form.append(
 'attachment',
 file,
 );
 }

 const originalText =
 button.textContent;

 button.disabled = true;
 button.textContent = 'Отправка...';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/support/tickets`,
 {
 method: 'POST',
 body: form,
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (!res.ok) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 titleInput.value = '';
 bodyInput.value = '';

 if (fileInput) {
 fileInput.value = '';
 }

 if ($('support-attachment-name')) {
 $('support-attachment-name').textContent =
 'JPEG, PNG или WebP · до 10 МБ';
 }

 toast('Обращение отправлено');

 tg?.HapticFeedback
 ?.notificationOccurred?.('success');

 await loadSupportTickets();
 } catch (error) {
 toast(
 error.message ||
 'Не удалось отправить обращение',
 );
 } finally {
 button.disabled = false;
 button.textContent = originalText;
 }
 }

 if ($('support-attachment')) {
 $('support-attachment').onchange = (event) => {
 const file =
 event.target.files?.[0] || null;

 $('support-attachment-name').textContent =
 file
 ? file.name
 : 'JPEG, PNG или WebP · до 10 МБ';
 };
 }

 if ($('btn-support-submit')) {
 $('btn-support-submit').onclick =
 submitSupportTicket;
 }


 if ($('btn-support-reply')) {
 $('btn-support-reply').onclick =
 submitSupportTicketReply;
 }


 if ($('btn-admin-ticket-reply')) {
 $('btn-admin-ticket-reply').onclick =
 submitAdminSupportReply;
 }


 document
 .querySelectorAll(
 '.admin-ticket-status-btn',
 )
 .forEach((button) => {
 button.onclick = () => {
 updateAdminTicketStatus(
 button.dataset.status,
 );
 };
 });

 $('btn-admin-refresh').onclick = loadAdminDashboard;
 $('btn-admin-notification-send').onclick = createAdminNotification;
 $('admin-modal-close').onclick = closeAdminNodeModal;
 $('admin-node-modal').onclick = (event) => {
 if (event.target === $('admin-node-modal')) closeAdminNodeModal();
 };

 $('purchase-done').onclick = () => {
 closePurchaseModal();
 };

 $('payment-back').onclick = () => {
 closePurchaseModal();
 };
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

 document.addEventListener('keydown', (event) => {
 if (event.key === 'Escape') {
 closeAdminNodeModal();

 if (!$('screen-payment').classList.contains('hidden')) {
 closePurchaseModal();
 }
 }
 });
 $('btn-copy-ref').onclick = () => {
 if (cabinet?.referralLink) copyText(cabinet.referralLink);
 };
 $('btn-apply-promo').onclick = async () => {
 const input =
 $('promo-input');

 const button =
 $('btn-apply-promo');

 const code =
 input.value
 .trim()
 .toUpperCase();

 if (code.length === 0) {
 return toast(
 'Введите промокод',
 );
 }

 const originalText =
 button.textContent;

 button.disabled = true;
 button.textContent =
 'Активация...';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/promo/redeem`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 code,
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 const messages = {
 'Promo code not found':
 'Промокод не найден',

 'Promo code is disabled':
 'Промокод отключён',

 'Promo code has expired':
 'Срок действия промокода истёк',

 'Promo code usage limit reached':
 'Лимит активаций промокода исчерпан',

 'Promo code user limit reached':
 'Вы уже использовали этот промокод',

 'Promo code is busy, try again':
 'Попробуйте активировать промокод ещё раз',
 };

 throw new Error(
 messages[data.message] ||
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 input.value = '';

 const days =
 Number(
 data.promo?.days || 0,
 );

 const plan =
 data.promo?.plan === 'PREMIUM'
 ? 'Премиум'
 : 'Стандарт';

 toast(
 `Промокод активирован: +${days} дн. · ${plan}`,
 );

 await load();

 showScreen('home');
 } catch (error) {
 toast(
 error.message ||
 'Не удалось активировать промокод',
 );
 } finally {
 button.disabled = false;
 button.textContent =
 originalText;
 }
 };

 async function createAdminPromoCode() {
 const button =
 $('btn-admin-promo-create');

 const code =
 $('admin-promo-code')
 ?.value
 ?.trim()
 ?.toUpperCase() || '';

 const plan =
 $('admin-promo-plan')
 ?.value || 'STANDARD';

 const days =
 Number(
 $('admin-promo-days')
 ?.value,
 );

 const maxUsesRaw =
 $('admin-promo-max-uses')
 ?.value
 ?.trim() || '';

 const userLimit =
 Number(
 $('admin-promo-user-limit')
 ?.value,
 );

 const validUntilRaw =
 $('admin-promo-valid-until')
 ?.value
 ?.trim() || '';

 const isActive =
 $('admin-promo-active')
 ?.checked ?? true;

 if (code.length < 3) {
 return toast(
 'Введите промокод',
 );
 }

 if (
 Number.isInteger(days) === false ||
 days < 1
 ) {
 return toast(
 'Укажите количество дней',
 );
 }

 if (
 Number.isInteger(userLimit) === false ||
 userLimit < 1
 ) {
 return toast(
 'Укажите лимит на пользователя',
 );
 }

 const maxUses =
 maxUsesRaw.length === 0
 ? null
 : Number(maxUsesRaw);

 if (
 maxUses !== null &&
 (
 Number.isInteger(maxUses) === false ||
 maxUses < 1
 )
 ) {
 return toast(
 'Проверьте общий лимит',
 );
 }

 let validUntil = null;

 if (validUntilRaw.length > 0) {
 const date =
 new Date(validUntilRaw);

 if (
 Number.isNaN(
 date.getTime(),
 )
 ) {
 return toast(
 'Проверьте срок действия',
 );
 }

 validUntil =
 date.toISOString();
 }

 const originalText =
 button.textContent;

 button.disabled = true;
 button.textContent =
 'Создание...';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/promo/create`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 code,
 plan,
 days,
 maxUses,
 perUserLimit: userLimit,
 validUntil,
 isActive,
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 $('admin-promo-code').value = '';

 toast(
 `Промокод ${data.promo?.code || code} создан`,
 );

 await loadAdminPromoCodes();
 } catch (error) {
 toast(
 error.message ||
 'Не удалось создать промокод',
 );
 } finally {
 button.disabled = false;
 button.textContent =
 originalText;
 }
 }


 async function openAdminPromoRedemptions(
 promo,
) {
 const list =
 $('admin-promo-redemption-list');

 const code =
 $('admin-promo-redemption-code');

 const meta =
 $('admin-promo-redemption-meta');

 if (
 list == null ||
 code == null ||
 meta == null
 ) {
 return;
 }

 code.textContent =
 promo.code;

 meta.textContent =
 `${promo.plan} · ${promo.days} дн.`;

 list.innerHTML =
 '<div class="empty-state">Загрузка...</div>';

 showScreen(
 'admin-promo-redemptions',
 );

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/promo/${promo.id}/redemptions`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 const items =
 Array.isArray(data.redemptions)
 ? data.redemptions
 : [];

 if (items.length === 0) {
 list.innerHTML =
 '<div class="empty-state">Активаций пока нет</div>';

 return;
 }

 list.replaceChildren();

 for (const item of items) {
 const card =
 document.createElement('div');

 card.className =
 'admin-promo-redemption-card';

 const top =
 document.createElement('div');

 top.className =
 'admin-promo-redemption-user';

 const name =
 document.createElement('strong');

 const fullName =
 [
 item.user?.firstName,
 item.user?.lastName,
 ]
 .filter(Boolean)
 .join(' ')
 .trim();

 name.textContent =
 item.user?.username
 ? `@${item.user.username}`
 : fullName ||
 `ID ${item.user?.telegramId || '—'}`;

 const date =
 document.createElement('span');

 date.textContent =
 new Date(
 item.createdAt,
 ).toLocaleString('ru-RU');

 top.append(
 name,
 date,
 );

 const info =
 document.createElement('div');

 info.className =
 'admin-promo-redemption-info';

 const telegramId =
 document.createElement('span');

 telegramId.textContent =
 `Telegram ID: ${item.user?.telegramId || '—'}`;

 const plan =
 document.createElement('span');

 plan.textContent =
 `${
 item.plan === 'PREMIUM'
 ? 'Премиум'
 : 'Стандарт'
 } · ${item.days} дн.`;

 info.append(
 telegramId,
 plan,
 );

 card.append(
 top,
 info,
 );

 list.append(
 card,
 );
 }
 } catch (error) {
 list.innerHTML = '';

 const empty =
 document.createElement('div');

 empty.className =
 'empty-state';

 empty.textContent =
 error.message ||
 'Не удалось загрузить активации';

 list.append(
 empty,
 );
 }
 }


 async function deleteAdminPromoCode(
 promo,
) {
 const confirmed =
 window.confirm(
 `Удалить промокод ${promo.code}?`,
 );

 if (confirmed === false) {
 return;
 }

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/promo/${promo.id}/delete`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 const message =
 data.message ||
 `Ошибка ${res.status}`;

 if (
 message.includes(
 'has redemptions',
 )
 ) {
 throw new Error(
 'Нельзя удалить использованный промокод. Его можно только отключить.',
 );
 }

 throw new Error(
 message,
 );
 }

 toast(
 `Промокод ${promo.code} удалён`,
 );

 await loadAdminPromoCodes();
 } catch (error) {
 toast(
 error.message ||
 'Не удалось удалить промокод',
 );
 }
 }


 async function setAdminPromoActive(
 promo,
 isActive,
) {
 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/promo/${promo.id}/active`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 isActive,
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 toast(
 isActive
 ? 'Промокод включён'
 : 'Промокод отключён',
 );

 await loadAdminPromoCodes();
 } catch (error) {
 toast(
 error.message ||
 'Не удалось изменить промокод',
 );
 }
 }


 function getAdminPromoStatus(
 promo,
) {
 const now =
 Date.now();

 const validUntil =
 promo.validUntil
 ? new Date(
 promo.validUntil,
 ).getTime()
 : null;

 if (promo.isActive === false) {
 return 'DISABLED';
 }

 if (
 validUntil !== null &&
 Number.isNaN(validUntil) === false &&
 validUntil <= now
 ) {
 return 'EXPIRED';
 }

 if (
 promo.maxUses !== null &&
 promo.maxUses !== undefined &&
 promo.usedCount >= promo.maxUses
 ) {
 return 'EXHAUSTED';
 }

 return 'ACTIVE';
 }


 function renderFilteredAdminPromoCodes() {
 const all =
 Array.isArray(
 window.__adminPromoCodes,
 )
 ? window.__adminPromoCodes
 : [];

 const search =
 $('admin-promo-search')
 ?.value
 ?.trim()
 ?.toUpperCase() || '';

 const status =
 $('admin-promo-status-filter')
 ?.value || 'ALL';

 const plan =
 $('admin-promo-plan-filter')
 ?.value || 'ALL';

 const filtered =
 all.filter(
 (promo) => {
 const searchOk =
 search.length === 0 ||
 String(
 promo.code || '',
 )
 .toUpperCase()
 .includes(search);

 const statusOk =
 status === 'ALL' ||
 getAdminPromoStatus(
 promo,
 ) === status;

 const planOk =
 plan === 'ALL' ||
 promo.plan === plan;

 return (
 searchOk &&
 statusOk &&
 planOk
 );
 },
 );

 renderAdminPromoCodes(
 filtered,
 );
 }


 function renderAdminPromoCodes(
 promos,
) {
 const list =
 $('admin-promo-list');

 if (list == null) {
 return;
 }

 if (promos.length === 0) {
 list.innerHTML =
 '<div class="empty-state">Промокодов пока нет</div>';

 return;
 }

 list.replaceChildren();

 const planNames = {
 STANDARD: 'Стандарт',
 PREMIUM: 'Премиум',
 };

 for (const promo of promos) {
 const card =
 document.createElement('div');

 card.className =
 'admin-promo-card';

 const head =
 document.createElement('div');

 head.className =
 'admin-promo-card-head';

 const code =
 document.createElement('strong');

 code.textContent =
 promo.code;

 const state =
 document.createElement('span');

 const expired =
 promo.validUntil &&
 new Date(promo.validUntil).getTime() <= Date.now();

 let stateText = 'Активен';

 if (promo.isActive === false) {
 stateText = 'Выключен';
 } else if (expired) {
 stateText = 'Истёк';
 } else if (
 promo.maxUses !== null &&
 promo.usedCount >= promo.maxUses
 ) {
 stateText = 'Исчерпан';
 }

 state.textContent =
 stateText;

 state.className =
 'admin-promo-state';

 if (stateText !== 'Активен') {
 state.classList.add(
 'inactive',
 );
 }

 head.append(
 code,
 state,
 );

 const info =
 document.createElement('div');

 info.className =
 'admin-promo-card-info';

 const usesText =
 promo.maxUses === null
 ? `${promo.usedCount} / ∞`
 : `${promo.usedCount} / ${promo.maxUses}`;

 const expiresText =
 promo.validUntil
 ? new Date(
 promo.validUntil,
 ).toLocaleString('ru-RU')
 : 'Без срока';

 info.innerHTML = `
  <span>
   ${planNames[promo.plan] || promo.plan}
  </span>
  <span>
   ${promo.days} дн.
  </span>
  <span>
   Активации: ${usesText}
  </span>
  <span>
   На пользователя: ${promo.perUserLimit}
  </span>
  <span>
   До: ${expiresText}
  </span>
 `;

 const actions =
 document.createElement('div');

 actions.className =
 'admin-promo-card-actions';

 const copyButton =
 document.createElement('button');

 copyButton.type =
 'button';

 copyButton.className =
 'admin-promo-action-btn';

 copyButton.textContent =
 'Скопировать';

 copyButton.onclick =
 async () => {
 await copyText(
 promo.code,
 );

 toast(
 'Промокод скопирован',
 );
 };

 const toggleButton =
 document.createElement('button');

 toggleButton.type =
 'button';

 toggleButton.className =
 'admin-promo-action-btn';

 toggleButton.textContent =
 promo.isActive
 ? 'Отключить'
 : 'Включить';

 toggleButton.onclick =
 async () => {
 toggleButton.disabled = true;

 try {
 await setAdminPromoActive(
 promo,
 promo.isActive === false,
 );
 } finally {
 toggleButton.disabled = false;
 }
 };

 const redemptionsButton =
 document.createElement('button');

 redemptionsButton.type =
 'button';

 redemptionsButton.className =
 'admin-promo-action-btn';

 redemptionsButton.textContent =
 `Активации (${promo.usedCount})`;

 redemptionsButton.onclick =
 () => {
 openAdminPromoRedemptions(
 promo,
 );
 };

 const deleteButton =
 document.createElement('button');

 deleteButton.type =
 'button';

 deleteButton.className =
 'admin-promo-action-btn admin-promo-delete-btn';

 deleteButton.textContent =
 'Удалить';

 deleteButton.onclick =
 async () => {
 deleteButton.disabled = true;

 try {
 await deleteAdminPromoCode(
 promo,
 );
 } finally {
 deleteButton.disabled = false;
 }
 };

 actions.append(
 copyButton,
 toggleButton,
 redemptionsButton,
 deleteButton,
 );

 card.append(
 head,
 info,
 actions,
 );

 list.append(
 card,
 );
 }

 }


 async function loadAdminPromoCodes() {
 const list =
 $('admin-promo-list');

 if (list == null) {
 return;
 }

 list.innerHTML =
 '<div class="empty-state">Загрузка...</div>';

 try {
 const res = await fetch(
 `${API_BASE}/api/webapp/admin/promo/list`,
 {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 },
 body: JSON.stringify({
 initData: getInitData(),
 }),
 },
 );

 const data =
 await res.json().catch(() => ({}));

 if (res.ok === false) {
 throw new Error(
 data.message ||
 `Ошибка ${res.status}`,
 );
 }

 const promos =
 Array.isArray(data.promos)
 ? data.promos
 : [];

 window.__adminPromoCodes =
 promos;

 renderFilteredAdminPromoCodes();
 } catch (error) {
 list.innerHTML = '';

 const empty =
 document.createElement('div');

 empty.className =
 'empty-state';

 empty.textContent =
 error.message ||
 'Не удалось загрузить промокоды';

 list.append(
 empty,
 );
 }
 }


 if ($('profile-generate-promo-btn')) {
 $('profile-generate-promo-btn').onclick =
 async () => {
 showScreen('admin-promo');
 await loadAdminPromoCodes();
 };
 }


 if ($('btn-admin-promo-create')) {
 $('btn-admin-promo-create').onclick =
 createAdminPromoCode;
 }


 if ($('admin-promo-search')) {
 $('admin-promo-search').oninput =
 renderFilteredAdminPromoCodes;
 }

 if ($('admin-promo-status-filter')) {
 $('admin-promo-status-filter').onchange =
 renderFilteredAdminPromoCodes;
 }

 if ($('admin-promo-plan-filter')) {
 $('admin-promo-plan-filter').onchange =
 renderFilteredAdminPromoCodes;
 }



/* ===== BONUSES START ===== */

function renderTelegramBonus(
  bonus,
) {
  const status =
    $('bonus-telegram-status');

  const claimButton =
    $('bonus-check-channel');

  const openButton =
    $('bonus-open-channel');

  if (
    !status ||
    !claimButton ||
    !openButton
  ) {
    return;
  }

  const state =
    String(
      bonus?.status ||
      'AVAILABLE',
    );

  status.classList.remove(
    'hidden',
    'is-pending',
    'is-confirmed',
    'is-revoked',
  );

  if (state === 'AVAILABLE') {
    status.classList.add('hidden');

    claimButton.disabled =
      false;

    claimButton.textContent =
      'Проверить подписку';

    openButton.disabled =
      false;

    return;
  }

  if (
    state === 'APPLYING'
  ) {
    status.classList.add(
      'is-pending',
    );

    status.innerHTML =
      '<strong>Начисляем бонус…</strong>';

    claimButton.disabled =
      true;

    claimButton.textContent =
      'Обработка';

    return;
  }

  if (
    state === 'PENDING'
  ) {
    status.classList.add(
      'is-pending',
    );

    let text =
      'Бонус получен: +7 дней. ' +
      'Оставайтесь подписаны 7 дней, ' +
      'чтобы бонус закрепился.';

    if (bonus.confirmAfter) {
      try {
        const date =
          new Date(
            bonus.confirmAfter,
          );

        text +=
          ' Проверка до ' +
          date.toLocaleDateString(
            'ru-RU',
          ) +
          '.';
      } catch (_) {}
    }

    status.innerHTML =
      '<strong>+7 дней начислено</strong>' +
      '<span>' +
      text +
      '</span>';

    claimButton.disabled =
      true;

    claimButton.textContent =
      'Бонус получен';

    openButton.disabled =
      false;

    return;
  }

  if (
    state === 'CONFIRMED'
  ) {
    status.classList.add(
      'is-confirmed',
    );

    status.innerHTML =
      '<strong>✓ Выполнено</strong>' +
      '<span>7 бонусных дней закреплены за вашей подпиской.</span>';

    claimButton.disabled =
      true;

    claimButton.textContent =
      'Получено';

    openButton.disabled =
      false;

    return;
  }

  if (
    state === 'REVOKED'
  ) {
    status.classList.add(
      'is-revoked',
    );

    status.innerHTML =
      '<strong>Бонус отозван</strong>' +
      '<span>Подписка на канал была отменена в течение контрольных 7 дней. Бонусные дни списаны.</span>';

    claimButton.disabled =
      true;

    claimButton.textContent =
      'Бонус использован';

    openButton.disabled =
      false;
  }
}


async function loadBonuses() {
  try {
    const response =
      await fetch(
        `${API_BASE}/api/webapp/bonuses`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            initData:
              getInitData(),
          }),
        },
      );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.message ||
        `Ошибка ${response.status}`,
      );
    }

    const bonus =
      Array.isArray(data.bonuses)
        ? data.bonuses[0]
        : null;

    renderTelegramBonus(
      bonus,
    );
  } catch (error) {
    toast(
      error.message ||
      'Не удалось загрузить бонусы',
    );
  }
}


if ($('profile-bonuses-btn')) {
  $('profile-bonuses-btn').onclick =
    async () => {
      showScreen('bonuses');
      await loadBonuses();
    };
}


if ($('bonus-open-channel')) {
  $('bonus-open-channel').onclick =
    () => {
      const url =
        'https://t.me/fourstepsinfo';

      if (
        tg?.openTelegramLink
      ) {
        tg.openTelegramLink(url);
      } else {
        window.open(
          url,
          '_blank',
        );
      }
    };
}


if ($('bonus-check-channel')) {
  $('bonus-check-channel').onclick =
    async () => {
      const button =
        $('bonus-check-channel');

      if (!button) {
        return;
      }

      const original =
        button.textContent;

      button.disabled =
        true;

      button.textContent =
        'Проверяем…';

      try {
        const response =
          await fetch(
            `${API_BASE}/api/webapp/bonuses/telegram/claim`,
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/json',
              },

              body:
                JSON.stringify({
                  initData:
                    getInitData(),
                }),
            },
          );

        const data =
          await response
            .json()
            .catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data.message ||
            `Ошибка ${response.status}`,
          );
        }

        renderTelegramBonus(
          data.bonus,
        );

        toast(
          data.alreadyClaimed
            ? 'Бонус уже был получен'
            : '+7 дней добавлено к подписке',
        );

        await load();
      } catch (error) {
        button.disabled =
          false;

        button.textContent =
          original;

        toast(
          error.message ||
          'Не удалось получить бонус',
        );
      }
    };
}

/* ===== BONUSES END ===== */


$('btn-retry').onclick = load;
 initBannerCarousel();
 load();
})();


/* ===== MOBILE KEYBOARD DISMISS ===== */

document.addEventListener(
 'pointerdown',
 (event) => {
 const active =
 document.activeElement;

 const isKeyboardField =
 active instanceof HTMLInputElement ||
 active instanceof HTMLTextAreaElement;

 if (isKeyboardField === false) {
 return;
 }

 const target =
 event.target instanceof Element
 ? event.target
 : null;

 if (target == null) {
 return;
 }

 const interactive =
 target.closest(
 'input, textarea, button, select, a, label, [contenteditable="true"]',
 );

 if (interactive == null) {
 active.blur();
 }
 },
);


/* Keep admin reply composer visible
   when mobile keyboard opens */

if ($('admin-ticket-reply-body')) {
 $('admin-ticket-reply-body')
 .addEventListener(
 'focus',
 () => {
 setTimeout(
 () => {
 const box =
 $('admin-ticket-reply-body')
 ?.closest(
 '.support-reply-box',
 );

 box?.scrollIntoView({
 behavior: 'smooth',
 block: 'nearest',
 });
 },
 250,
 );
 },
 );
}

/* ===== MOBILE KEYBOARD DISMISS END ===== */
