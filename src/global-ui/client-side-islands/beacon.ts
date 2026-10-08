/**
 * Beacon-based page view tracking
 *
 * Sends the current pathname to `/api/analytics/view`
 * The `data-spr-count` attribute on `<html>` controls whether a view is counted
 * Called on initial page load and after fragment navigation
 *
 * Errors are swallowed so tracking never breaks page rendering
 */

const ENDPOINT = '/api/analytics/view';

export const COUNT_ATTRIBUTE = 'data-spr-count'; // Attribute on `<html>` that marks pages whose view should be counted

export function countView(): void {
  const body = JSON.stringify({ path: location.pathname });
  try {
    if (navigator.sendBeacon) {
      // sendBeacon queues outside the page lifecycle, surviving navigation
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    // Fallback: keepalive fetch also survives page navigation
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Analytics failure must not affect the page
  }
}

export function mountBeacon(): void {
  if (document.documentElement.hasAttribute(COUNT_ATTRIBUTE)) countView();
}

export function countFragment(countable: boolean): void {
  const root = document.documentElement;
  if (countable) {
    root.setAttribute(COUNT_ATTRIBUTE, '');
    countView();
  } else {
    root.removeAttribute(COUNT_ATTRIBUTE);
  }
}
