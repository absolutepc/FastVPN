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
    const params = new URLSearchParams(window.location.search);
    if (params.get('mock')) return `mock:${params.get('mock')}`;
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
    const all = [...main, 'promo', 'ref'];
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

    const sub = data.subscription;
    const state = data.subscriptionState || (sub ? 'ACTIVE' : 'NONE');
    const deviceLimit = data.deviceLimit ?? 1;
    const deviceUsed = data.deviceUsed ?? 0;
    const left = data.daysLeft ?? (sub ? daysLeft(sub.expiresAt) : 0);

    if (state === 'ACTIVE' && sub) {
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';

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
      $('dev-list').innerHTML =
        '<div class="dev-item">' +
        '<div class="dev-item-ico">📱</div>' +
        '<div><div class="dev-item-name">Ваше устройство</div>' +
        '<div class="dev-item-meta">Подписка · ' + planName + '</div></div>' +
        '<span class="dev-online">Онлайн</span></div>';
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

    if (state === 'EXPIRED') {
      $('greet-status').textContent = 'Срок подписки истёк';
      $('hero-title').textContent = 'Подписка истекла';
      $('hero-sub').textContent = 'Продлите подписку, чтобы восстановить доступ';
      $('sub-url').textContent = 'Доступ приостановлен';
      $('smart-desc').textContent = 'Продлите подписку для получения доступа';
      $('sub-plan-name').textContent = 'Подписка истекла';
      $('sub-plan-desc').textContent = 'Продлите тариф, чтобы снова подключиться';
      $('btn-renew').textContent = 'Продлить подписку ›';
      $('dev-list').innerHTML =
        '<div class="dev-empty" id="dev-empty">Подписка истекла.<br/>После продления доступ на устройстве восстановится.</div>';
      return;
    }

    $('greet-status').textContent = 'Подписка не оформлена';
    $('hero-title').textContent = 'Подписка не активна';
    $('hero-sub').textContent = 'Оформите тариф, чтобы начать';
    $('sub-url').textContent = 'Нет активной подписки';
    $('smart-desc').textContent = 'Сначала оформите подписку';
    $('sub-plan-name').textContent = 'Нет подписки';
    $('sub-plan-desc').textContent = 'Выберите тариф ниже';
    $('btn-renew').textContent = 'Оформить подписку ›';
    $('dev-list').innerHTML =
      '<div class="dev-empty" id="dev-empty">Нет активной подписки.<br/>После оплаты здесь появится ваше устройство.</div>';
  }

  async function load() {
    $('error-screen').classList.add('hidden');
    const initData = getInitData();
    if (!initData) {
      $('error-text').textContent = 'Откройте из бота или ?mock=ВАШ_ID';
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

  async function buy(plan) {
    const initData = getInitData();
    if (!initData) return toast('Нет авторизации');
    document.querySelectorAll('[data-plan]').forEach((b) => (b.disabled = true));
    try {
      const res = await fetch(`${API_BASE}/api/webapp/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, plan }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Ошибка оплаты');
      if (data.confirmationUrl) {
        if (tg?.openLink) tg.openLink(data.confirmationUrl);
        else window.open(data.confirmationUrl, '_blank');
      } else toast('Нет ссылки на оплату');
    } catch (e) {
      toast(e.message || 'Ошибка');
    } finally {
      document.querySelectorAll('[data-plan]').forEach((b) => (b.disabled = false));
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
  $('btn-renew').onclick = () => {
    const el = document.querySelector('.plans');
    el?.scrollIntoView({ behavior: 'smooth' });
  };
  $('btn-copy-sub').onclick = copySub;
  $('btn-copy-sub-top').onclick = copySub;
  $('btn-add-device').onclick = () => showScreen('servers');

  document.querySelectorAll('.plan').forEach((row) => {
    row.onclick = () => buy(row.dataset.plan);
  });

  $('menu-promo').onclick = () => showScreen('promo');
  $('menu-ref').onclick = () => showScreen('ref');
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
