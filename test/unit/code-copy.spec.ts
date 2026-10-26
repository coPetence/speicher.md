/**
 * @jest-environment jsdom
 */
import { mountCodeCopy } from '../../src/global-ui/client-side-islands/code-copy';

const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  document.body.innerHTML =
    '<main class="spr-main"><pre><code class="language-yaml">version: 1\nauth: {}</code></pre></main>';
});

describe('copying a code block', () => {
  it('adds one button per block, also when mounted again', () => {
    mountCodeCopy();
    mountCodeCopy();
    expect(document.querySelectorAll('.spr-code > pre')).toHaveLength(1);
    expect(document.querySelectorAll('.spr-code > .spr-code-copy')).toHaveLength(1);
  });

  it("writes the block's text to the clipboard and says so", async () => {
    mountCodeCopy();
    const button = document.querySelector<HTMLButtonElement>('.spr-code-copy');
    button?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('version: 1\nauth: {}');
    expect(button?.dataset.sprState).toBe('copied');
    expect(button?.getAttribute('aria-label')).toBe('Copied');
  });

  it('adds nothing where the browser cannot copy', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    mountCodeCopy();
    expect(document.querySelector('.spr-code-copy')).toBeNull();
  });
});
