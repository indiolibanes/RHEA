(() => {
  const root = document.documentElement;
  const choices = { mode: ['autoral', 'serio'], theme: ['dark', 'light'], palette: ['noite', 'ametista', 'esmeralda'], glass: ['off', 'on'] };
  const key = 'rhea.appearance.v1';

  try {
    const saved = JSON.parse(localStorage.getItem(key));
    for (const [property, values] of Object.entries(choices)) {
      if (values.includes(saved?.[property])) root.dataset[property] = saved[property];
    }
  } catch {
    // The default appearance also works in storage-restricted sessions.
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const container of document.querySelectorAll('.view-options')) {
      container.append(document.querySelector('#view-template').content.cloneNode(true));
    }

    const reflect = () => {
      for (const input of document.querySelectorAll('[data-select-palette]')) {
        input.setAttribute('aria-pressed', input.dataset.selectPalette === root.dataset.palette);
      }
      for (const input of document.querySelectorAll('[data-toggle-theme]')) {
        input.textContent = root.dataset.theme === 'dark' ? '◐ Tema claro' : '◐ Tema escuro';
      }
      for (const input of document.querySelectorAll('[data-toggle-glass]')) {
        input.setAttribute('aria-pressed', root.dataset.glass === 'on');
      }
      for (const input of document.querySelectorAll('[data-toggle-mode]')) {
        input.textContent = root.dataset.mode === 'autoral' ? 'Modo sério' : 'Modo autoral';
      }
    };

    document.querySelectorAll('.appearance button').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.selectPalette) root.dataset.palette = button.dataset.selectPalette;
      if ('toggleTheme' in button.dataset) root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      if ('toggleMode' in button.dataset) root.dataset.mode = root.dataset.mode === 'autoral' ? 'serio' : 'autoral';
      if ('toggleGlass' in button.dataset) root.dataset.glass = root.dataset.glass === 'off' ? 'on' : 'off';
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
