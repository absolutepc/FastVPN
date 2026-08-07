(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#0a0f0c');
      tg.setBackgroundColor('#0a0f0c');
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

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return '—';
    }
  }

  function showScreen(name) {
    ['home', 'buy', 'promo', 'ref'].forEach((s) => {
      $(`screen-${s}`).classList.toggle('hidden', s !== name);
    });
    window.scrollTo(0, 0);
  }

  function render(data) {
    cabinet = data;
    const name = data.user?.firstName || data.user?.username || 'Пользователь';
    $('user-name').textContent = name;
    $('user-username').textContent = data.user?.username ? `@${data.user.username}` : '';
    $('avatar').textContent = (name[0] || '?').toUpperCase();

    const sub = data.subscription;
    if (sub) {
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';
      $('stat-plan').textContent = planName;
      $('stat-expires').textContent = formatDate(sub.expiresAt);
      $('stat-status').textContent = sub.isTrial ? 'Пробный' : 'Активна';
      $('stat-status').className = 'stat-value ' + (sub.isTrial ? 'trial' : 'on');

      $('sub-block').classList.remove('hidden');
      $('sub-url').textContent = sub.subUrl;
      $('btn-copy-sub').onclick = () => copyText(sub.subUrl);
    } else {
      $('stat-plan').textContent = 'Нет';
      $('stat-expires').textContent = '—';
      $('stat-status').textContent = 'Неактивна';
      $('stat-status').className = 'stat-value off';
      $('sub-block').classList.add('hidden');
    }

    $('ref-link').textContent = data.referralLink || '—';
  }

  async function load() {
    $('error-screen').classList.add('hidden');
    const initData = getInitData();

    if (!initData) {
      $('error-text').textContent =
        'Откройте кабинет из Telegram-бота или добавьте ?mock=ВАШ_TELEGRAM_ID';
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
      $('error-text').textContent = e.message || 'Не удалось загрузить';
      $('error-screen').classList.remove('hidden');
    }
  }

  async function buy(plan) {
    const initData = getInitData();
    if (!initData) return toast('Нет авторизации');

    const buttons = document.querySelectorAll('.plan-buy');
    buttons.forEach((b) => (b.disabled = true));

    try {
      const res = await fetch(`${API_BASE}/api/webapp/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, plan }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Ошибка оплаты. Проверьте ЮKassa.');
      }
      if (data.confirmationUrl) {
        if (tg?.openLink) tg.openLink(data.confirmationUrl);
        else window.open(data.confirmationUrl, '_blank');
      } else {
        toast('Ссылка на оплату не получена');
      }
    } catch (e) {
      toast(e.message || 'Ошибка');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  $('btn-buy').onclick = () => showScreen('buy');
  $('btn-renew').onclick = () => {
    if (!cabinet?.subscription) {
      toast('Нет активной подписки — выберите тариф');
    }
    showScreen('buy');
  };
  $('btn-promo').onclick = () => showScreen('promo');
  $('btn-ref').onclick = () => showScreen('ref');

  $('back-from-buy').onclick = () => showScreen('home');
  $('back-from-promo').onclick = () => showScreen('home');
  $('back-from-ref').onclick = () => showScreen('home');

  document.querySelectorAll('.plan-buy').forEach((btn) => {
    btn.onclick = () => {
      const plan = btn.closest('.plan-card')?.dataset.plan;
      buy(plan);
    };
  });

  $('btn-copy-ref').onclick = () => {
    if (cabinet?.referralLink) copyText(cabinet.referralLink);
  };

  $('btn-apply-promo').onclick = () => {
    const code = $('promo-input').value.trim();
    if (!code) return toast('Введите промокод');
    toast('Промокоды скоро будут доступны');
  };

  $('btn-retry').onclick = load;
  load();
})();
