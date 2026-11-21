(() => {
  const root = document.documentElement;
  const choices = { mode: ['autoral', 'serio'], tone: ['floresta', 'terra', 'marfim'], glass: ['off', 'on'] };
  const key = 'rhea.appearance.v2';
  const legacyKey = 'rhea.appearance.v1';
  const labels = { floresta: 'Floresta', terra: 'Terra', marfim: 'Marfim' };

  // Marfim is the only light tone; the theme follows the tone.
  const applyTheme = () => { root.dataset.theme = root.dataset.tone === 'marfim' ? 'light' : 'dark'; };

  try {
    let saved = JSON.parse(localStorage.getItem(key));
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem(legacyKey));
      if (legacy) saved = { mode: legacy.mode, glass: legacy.glass, tone: legacy.theme === 'light' ? 'marfim' : 'floresta' };
    }
    for (const [property, values] of Object.entries(choices)) {
      if (values.includes(saved?.[property])) root.dataset[property] = saved[property];
    }
  } catch {
    // The default appearance also works in storage-restricted sessions.
  }
  applyTheme();

  document.addEventListener('DOMContentLoaded', () => {
    for (const container of document.querySelectorAll('.view-options')) {
      container.append(document.querySelector('#view-template').content.cloneNode(true));
    }

    const reflect = () => {
      for (const input of document.querySelectorAll('[data-select-tone]')) {
        input.setAttribute('aria-pressed', input.dataset.selectTone === root.dataset.tone);
        input.title = labels[input.dataset.selectTone];
      }
      for (const input of document.querySelectorAll('[data-toggle-glass]')) {
        input.setAttribute('aria-pressed', root.dataset.glass === 'on');
      }
      for (const input of document.querySelectorAll('[data-toggle-mode]')) {
        input.textContent = root.dataset.mode === 'autoral' ? 'Modo sério' : 'Modo autoral';
      }
    };

    document.querySelectorAll('.appearance button').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.selectTone) root.dataset.tone = button.dataset.selectTone;
      if ('toggleMode' in button.dataset) root.dataset.mode = root.dataset.mode === 'autoral' ? 'serio' : 'autoral';
      if ('toggleGlass' in button.dataset) root.dataset.glass = root.dataset.glass === 'off' ? 'on' : 'off';
      applyTheme();
      reflect();
      try {
        localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.keys(choices).map(property => [property, root.dataset[property]]))));
      } catch {
        // Session controls remain available.
      }
    }));
    reflect();
  });
})();
