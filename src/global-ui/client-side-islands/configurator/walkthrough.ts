export function mountWalkthroughs(): void {
  for (const modal of document.querySelectorAll<HTMLDetailsElement>('[data-spr-walkthrough]')) {
    const slides = [...modal.querySelectorAll<HTMLElement>('[data-spr-walkthrough-slide]')];
    const dots = [...modal.querySelectorAll<HTMLElement>('[data-spr-walkthrough-dot]')];
    const back = modal.querySelector<HTMLElement>('[data-spr-walkthrough-back]');
    const next = modal.querySelector<HTMLElement>('[data-spr-walkthrough-next]');
    const done = modal.querySelector<HTMLElement>('[data-spr-walkthrough-done]');
    const strip = modal.querySelector<HTMLElement>('[data-spr-walkthrough-dots]');
    if (slides.length === 0) continue;

    let at = 0;
    const show = (index: number): void => {
      at = Math.max(0, Math.min(index, slides.length - 1));
      slides.forEach((slide, each) => {
        slide.hidden = each !== at;
      });
      dots.forEach((dot, each) => dot.toggleAttribute('data-spr-current', each === at));
      const last = at === slides.length - 1;
      if (back) back.hidden = at === 0;
      if (next) next.hidden = last;
      if (done) done.hidden = !last;
    };

    if (strip) strip.hidden = slides.length < 2;
    back?.addEventListener('click', () => show(at - 1));
    next?.addEventListener('click', () => show(at + 1));
    modal.addEventListener('toggle', () => {
      if (modal.open) show(0);
    });
    show(0);
  }
}
