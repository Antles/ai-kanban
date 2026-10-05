// Sets data-theme on <html> before the page paints: the saved choice ("light" / "dark"),
// or the system setting when there is none. Loaded as a classic script in <head>.
(() => {
  const media = matchMedia('(prefers-color-scheme: light)');
  const saved = () => {
    try {
      return localStorage.getItem('kanban.theme');
    } catch {
      return null;
    }
  };
  const apply = () => {
    const choice = saved();
    document.documentElement.dataset.theme = choice === 'light' || choice === 'dark' ? choice : media.matches ? 'light' : 'dark';
  };
  apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', (e) => e.key === 'kanban.theme' && apply());
  window.kanbanTheme = {
    get: () => saved() ?? 'system',
    set(choice) {
      try {
        if (choice === 'system') localStorage.removeItem('kanban.theme');
        else localStorage.setItem('kanban.theme', choice);
      } catch {
        /* storage unavailable: applies to this page only */
      }
      apply();
    },
  };
})();
