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
    const ms = new Date(iso) - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
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

  function showScreen(name) {
    const main = ['home', 'connect', 'sub', 'profile'];
    const all = [...main, 'promo', 'ref'];
    all.forEach((s) => $(`screen-${s}`)?.classList.toggle('hidden', s !== name));

    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === name);
    });

    const tabbar = $('tabbar');
    tabbar.style.display = main.includes(name) ? 'flex' : 'none';

    window.scrollTo(0, 0);
  }

  function render(data) {
    cabinet = data;
    const name = data.user?.firstName || data.user?.username || 'друг';
    $('greet-name').textContent = name;
    $('user-name').textContent = name;
    $('avatar').textContent = (name[0] || '?').toUpperCase();
    $('user-meta').textContent = data.user?.username ? `@${data.user.username}` : '';
    $('ps-ref').textContent = data.user?.referralCode ? '✓' : '—';
    $('ref-link').textContent = data.referralLink || '—';

    const sub = data.subscription;
    if (sub) {
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';
      const left = daysLeft(sub.expiresAt);

      $('greet-status').textContent = 'Ваш доступ активен';
      $('greet-status').className = 'greet-status on';
      $('hero-icon').textContent = '✓';
      $('hero-title').textContent = 'Подписка активна';
      $('hero-sub').textContent = sub.isTrial ? `${planName} · пробный период` : `${planName} · вы в безопасности`;

      $('stat-days').textContent = String(left);
      $('stat-devices').textContent = '1 из 1';
      $('stat-plan-short').textContent = planName;

      $('sub-url').textContent = sub.subUrl;

      $('sub-plan-name').textContent = planName;
      $('sub-plan-desc').textContent = sub.plan === 'PREMIUM'
        ? 'Максимум возможностей'
        : 'Базовый доступ';
      $('sub-badge').hidden = false;
      $('days-num').textContent = `${left} ${left === 1 ? 'день' : left < 5 ? 'дня' : 'дней'}`;
      $('days-until').textContent = `До ${formatDate(sub.expiresAt)}`;
      const pct = Math.min(100, Math.round((left / 30) * 100));
      $('progress-bar').style.width = `${pct}%`;

      $('ps-plan').textContent = planName;
    } else {
      $('greet-status').textContent = 'Подписка не оформлена';
      $('greet-status').className = 'greet-status';
      $('hero-icon').textContent = '!';
      $('hero-title').textContent = 'Подписка не активна';
      $('hero-sub').textContent = 'Оформите тариф, чтобы начать';

      $('stat-days').textContent = '0';
      $('stat-devices').textContent = '0 из 1';
      $('stat-plan-short').textContent = '—';

      $('sub-url').textContent = 'Нет активной подписки';

      $('sub-plan-name').textContent = 'Нет подписки';
      $('sub-plan-desc').textContent = 'Выберите тариф ниже';
      $('sub-badge').hidden = true;
      $('days-num').textContent = '—';
      $('days-until').textContent = '';
      $('progress-bar').style.width = '0%';
      $('ps-plan').textContent = '—';
    }
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
        throw new Error(err.message || `Ошибка ${res.status}`);
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
    const buttons = document.querySelectorAll('[data-plan]');
    buttons.forEach((b) => (b.disabled = true));
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
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  // Tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => showScreen(t.dataset.tab);
  });

  document.querySelectorAll('[data-back]').forEach((b) => {
    b.onclick = () => showScreen(b.dataset.back);
  });

  $('btn-details').onclick = () => {
    if (!cabinet?.subscription) {
      toast('Сначала оформите подписку');
      showScreen('sub');
      return;
    }
    showScreen('connect');
  };

  $('btn-go-buy').onclick = () => showScreen('sub');
  $('btn-renew').onclick = () => showScreen('sub');

  document.querySelectorAll('.plan-row').forEach((row) => {
    row.onclick = () => buy(row.dataset.plan);
  });

  $('btn-copy-sub').onclick = () => {
    const url = cabinet?.subscription?.subUrl;
    if (url) copyText(url);
    else toast('Нет активной подписки');
  };

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
  load();
})();
