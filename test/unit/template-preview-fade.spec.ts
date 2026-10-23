/**
 * @jest-environment jsdom
 */
import { mountPreviewFades } from '../../src/global-ui/client-side-islands/configurator/template-preview-fade';

describe('the theme previews', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span class="spr-template-frame"><iframe src="/-/config/preview/glass"></iframe></span>`;
  });

  const frame = () => document.querySelector('iframe') as HTMLIFrameElement;

  it('stay hidden until their page has loaded, then fade in', () => {
    mountPreviewFades();
    expect(frame().hasAttribute('data-spr-fade')).toBe(true);
    expect(frame().hasAttribute('data-spr-loaded')).toBe(false);

    frame().dispatchEvent(new Event('load'));
    expect(frame().hasAttribute('data-spr-loaded')).toBe(true);
  });

  it('leave a page that is not a preview alone', () => {
    document.body.innerHTML = '<iframe src="/elsewhere"></iframe>';
    mountPreviewFades();
    expect(frame().hasAttribute('data-spr-fade')).toBe(false);
  });
});
