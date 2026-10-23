/** Fades each theme preview in once its page has loaded */
export function mountPreviewFades(): void {
  const frames = document.querySelectorAll<HTMLIFrameElement>('.spr-template-frame > iframe');
  for (const frame of Array.from(frames)) {
    const page = frame.contentDocument;
    if (page && page.URL !== 'about:blank' && page.readyState === 'complete') continue;

    frame.setAttribute('data-spr-fade', '');
    frame.addEventListener('load', () => frame.setAttribute('data-spr-loaded', ''), {
      once: true,
    });
  }
}
