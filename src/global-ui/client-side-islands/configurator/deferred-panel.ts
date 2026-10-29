/**
 * `data-spr-defer`: a panel that answers at once and is swapped for its result once that has run
 *
 * A check that asks another service, such as the repository check of a GitHub
 * source, would hold the whole page until the slowest answer came. The page is
 * drawn with a pending panel instead, which names the address the check runs at;
 * this fetches that page and puts the panel with the same `data-spr-defer-key`
 * in place of the pending one. Where nothing runs, the panel's link runs it by
 * loading that page.
 */

export function mountDeferredPanels(): void {
  for (const panel of document.querySelectorAll<HTMLElement>('[data-spr-defer]')) {
    const url = panel.dataset.sprDefer ?? '';
    const key = panel.dataset.sprDeferKey ?? '';
    if (url === '' || key === '') continue;

    const text = panel.querySelector<HTMLElement>('[data-spr-defer-text]');
    // The link is for where nothing runs; here the check starts by itself
    const link = text?.querySelector('a');
    link?.remove();

    void (async () => {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        });
        if (!response.ok) throw new Error(`the check answered ${response.status}`);
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const done = Array.from(page.querySelectorAll<HTMLElement>('[data-spr-defer-key]')).find(
          (each) => each.dataset.sprDeferKey === key && !each.hasAttribute('data-spr-defer'),
        );
        if (!done) throw new Error('the check answered without its result');
        panel.replaceWith(document.importNode(done, true));
      } catch {
        // Offer the link again, to run the check by loading its page
        panel.removeAttribute('aria-busy');
        if (text && link) {
          text.textContent = 'The check did not finish here. ';
          text.append(link);
        }
      }
    })();
  }
}
