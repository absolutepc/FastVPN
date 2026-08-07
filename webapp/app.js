(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#0b0f14');
      tg.setBackgroundColor('#0b0f14');
    } catch (_) {}
  }

  const $ = (id) => document.getElementById(id);

  // API base: same origin when served from Nest, or override
  const API_BASE = window.location.origin;

  function getInitData() {
    if (tg?.initData) return tg.initData;
    // Local preview without Telegram
    const params = new URLSearchParams(window.location.search);
    if (params.get('mock')) return `mock:${params.get('mock')}`;
    return '';
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано');
      if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch {
      toast('Не удалось скопировать');
    }
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  function render(data) {
    const name = data.user?.firstName || data.user?.username || 'Вы';
    $('user-name').textContent = name;

    const sub = data.subscription;
    const statusEl = $('status-value');
    const metaEl = $('status-meta');
    const subSection = $('sub-section');

    if (sub) {
      const planName = sub.plan === 'PREMIUM' ? 'Премиум' : 'Стандарт';
      statusEl.textContent = sub.isTrial ? `${planName} · пробный` : planName;
      statusEl.className = 'status-value ' + (sub.isTrial ? 'trial' : 'active');
      metaEl.textContent = `до ${formatDate(sub.expiresAt)}`;

      subSection.classList.remove('hidden');
      $('sub-url').textContent = sub.subUrl;
      $('btn-copy').onclick = () => copyText(sub.subUrl);
    } else {
      statusEl.textContent = 'Нет активной подписки';
      statusEl.className = 'status-value none';
      metaEl.textContent = 'Выберите тариф ниже';
      subSection.classList.add('hidden');
    }

    $('ref-link').textContent = data.referralLink || '—';
    $('btn-copy-ref').onclick = () => {
      if (data.referralLink) copyText(data.referralLink);
    };

    document.querySelectorAll('.plan-btn').forEach((btn) => {
      const plan = btn.closest('.plan')?.dataset.plan;
      btn.onclick = () => buy(plan);
    });
  }

  async function load() {
    $('error-screen').classList.add('hidden');
    const initData = getInitData();

    if (!initData) {
      $('error-text').textContent =
        'Откройте кабинет из Telegram-бота или добавьте ?mock=ВАШ_TELEGRAM_ID для локального просмотра.';
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

      const data = await res.json();
      render(data);
    } catch (e) {
      $('error-text').textContent = e.message || 'Не удалось загрузить данные';
      $('error-screen').classList.remove('hidden');
    }
  }

  async function buy(plan) {
    const initData = getInitData();
    if (!initData) return toast('Нет авторизации');

    const buttons = document.querySelectorAll('.plan-btn');
    buttons.forEach((b) => (b.disabled = true));

    try {
      const res = await fetch(`${API_BASE}/api/webapp/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, plan }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || 'Ошибка оплаты. ЮKassa может быть не настроена.');
      }

      if (data.confirmationUrl) {
        if (tg?.openLink) {
          tg.openLink(data.confirmationUrl);
        } else {
          window.open(data.confirmationUrl, '_blank');
        }
      } else {
        toast('Ссылка на оплату не получена');
      }
    } catch (e) {
      toast(e.message || 'Ошибка');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  $('btn-retry').onclick = load;
  load();
})();
