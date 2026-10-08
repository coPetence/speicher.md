import { PALETTE_KEYS } from '../../src/config/palette';
import { DEFAULT_TEMPLATE, templateNames } from '../../src/content-reader/assets.controller';
import { templatePalette } from '../../src/content-reader/template-palette';

describe('a template’s own palette', () => {
  const templates = templateNames();

  it('answers every colour the form offers, in both schemes', () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      for (const scheme of ['light', 'dark'] as const) {
        const palette = templatePalette(template, scheme);
        expect(Object.keys(palette).sort()).toEqual([...PALETTE_KEYS].sort());
        for (const hex of Object.values(palette)) expect(hex).toMatch(/^#[0-9a-f]{3,6}$/);
      }
    }
  });

  it('keeps the two schemes apart', () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(templatePalette(template, 'light')).not.toEqual(templatePalette(template, 'dark'));
    }
  });

  it('reads a template’s own overrides, not the base sheet it carries', () => {
    const others = templates.filter((name) => name !== DEFAULT_TEMPLATE);
    expect(others.length).toBeGreaterThan(0);

    const base = templatePalette(DEFAULT_TEMPLATE, 'light');
    for (const template of others) {
      expect(templatePalette(template, 'light')).not.toEqual(base);
    }
  });

  it('falls back to the default for a name this build does not have', () => {
    expect(templatePalette('not-a-template', 'light')).toEqual(
      templatePalette(DEFAULT_TEMPLATE, 'light'),
    );
  });
});
