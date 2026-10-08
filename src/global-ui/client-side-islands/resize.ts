/**
 * Navigation tree resize handle
 *
 * Creates a draggable separator after the nav, for pointer and keyboard control
 * Width is stored as `--spr-nav-user` and persisted in a cookie
 * The server reads the cookie and emits the initial value as an inline style
 *
 * Only visible on wide viewports (the handle has `display:block` above the breakpoint)
 */

/** Cookie name, read by the server to emit the initial `--spr-nav-user` value */
const WIDTH_COOKIE = 'speicher_nav_width';

/** CSS custom property that feeds into `--spr-nav-width`, clamped by the stylesheet */
const WIDTH_PROPERTY = '--spr-nav-user';

/** One year */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Root font size in pixels, step unit for keyboard resize */
function rem(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Current nav tree width
 *
 * Falls back to `--spr-nav-user` when `getBoundingClientRect` returns 0
 * The DOM measurement is 0 when the nav is not displayed
 */
function currentWidth(nav: HTMLElement): number {
  const measured = nav.getBoundingClientRect().width;
  if (measured > 0) return measured;

  return parseFloat(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)) || 0;
}

/**
 * Creates the resize handle after the nav and wires pointer and keyboard events
 */
export function mountResizer(): void {
  const layout = document.querySelector<HTMLElement>('.spr-layout');
  const nav = document.querySelector<HTMLElement>('nav.spr-nav');

  if (!layout || !nav || layout.querySelector('.spr-nav-resize')) return;

  const handle = document.createElement('div');
  handle.className = 'spr-nav-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the contents');
  if (!nav.id) nav.id = 'spr-nav';
  handle.setAttribute('aria-controls', nav.id);

  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  handle.tabIndex = 0;

  nav.after(handle);

  const report = (): void => {
    const width = currentWidth(nav);
    const total = layout.getBoundingClientRect().width;
    handle.setAttribute('aria-valuenow', String(total > 0 ? Math.round((width / total) * 100) : 0));
    handle.setAttribute('aria-valuetext', `${Math.round(width)} pixels`);
  };

  const setWidth = (px: number): void => {
    document.documentElement.style.setProperty(WIDTH_PROPERTY, `${Math.round(px)}px`);
    report();
  };

  const persist = (): void => {
    const width = Math.round(currentWidth(nav));
    if (width <= 0) return;
    // Not always set: browsers reject the Secure flag on HTTP connections
    const secure = location.protocol === 'https:' ? '; secure' : '';

    document.cookie = `${WIDTH_COOKIE}=${width}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax${secure}`;
  };

  const onMove = (event: PointerEvent): void => {
    setWidth(event.clientX - layout.getBoundingClientRect().left);
  };

  const onUp = (): void => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    document.documentElement.removeAttribute('data-spr-resizing');
    persist();
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;

    event.preventDefault();
    // Lets the stylesheet show the handle highlight during drag
    document.documentElement.setAttribute('data-spr-resizing', '');

    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  });

  handle.addEventListener('keydown', (event) => {
    const step = rem();
    switch (event.key) {
      case 'ArrowLeft':
        setWidth(currentWidth(nav) - step);
        break;
      case 'ArrowRight':
        setWidth(currentWidth(nav) + step);
        break;

      case 'Home':
        setWidth(0);
        break;
      case 'End':
        setWidth(layout.getBoundingClientRect().width);
        break;
      default:
        return;
    }
    event.preventDefault();
    persist();
  });

  report();
}
