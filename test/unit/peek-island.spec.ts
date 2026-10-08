/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLE = (() => {
  const dir = join(__dirname, '../../dist/client');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >;
  return readFileSync(join(dir, manifest.tree), 'utf8');
})();

const PEEK = 'data-spr-peek';
const held = () => document.documentElement.hasAttribute(PEEK);

function press(init: KeyboardEventInit): void {
  dispatchEvent(new KeyboardEvent('keydown', init));
}
function release(init: KeyboardEventInit): void {
  dispatchEvent(new KeyboardEvent('keyup', init));
}

beforeEach(() => {
  document.documentElement.removeAttribute(PEEK);
  document.body.innerHTML = '<main><a href="/x" data-spr-preview="A page">x</a></main>';
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
});

describe('the peek modifier', () => {
  it('marks the root while Control is down and clears it on release', () => {
    press({ key: 'Control', ctrlKey: true });
    expect(held()).toBe(true);
    release({ key: 'Control', ctrlKey: false });
    expect(held()).toBe(false);
  });

  it('treats Cmd the same, with no platform branch', () => {
    press({ key: 'Meta', metaKey: true });
    expect(held()).toBe(true);
    release({ key: 'Meta', metaKey: false });
    expect(held()).toBe(false);
  });

  it('ignores keys that are not the modifier', () => {
    press({ key: 'a' });
    expect(held()).toBe(false);
    press({ key: 'Shift', shiftKey: true });
    expect(held()).toBe(false);
  });

  it('stays down across a chord, so Cmd+letter does not drop the peek', () => {
    press({ key: 'Meta', metaKey: true });
    press({ key: 'c', metaKey: true });
    expect(held()).toBe(true);
    release({ key: 'c', metaKey: true });
    expect(held()).toBe(true);
  });

  it('lets go when the window does', () => {
    press({ key: 'Meta', metaKey: true });
    expect(held()).toBe(true);
    dispatchEvent(new Event('blur'));
    expect(held()).toBe(false);
  });

  it('lets go when the tab is hidden', () => {
    press({ key: 'Control', ctrlKey: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(held()).toBe(false);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('does not swallow the key', () => {
    const event = new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, cancelable: true });
    dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
