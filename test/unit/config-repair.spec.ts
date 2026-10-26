import { loadInstanceConfig } from '../../src/config/parser';
import { repairInstanceConfig } from '../../src/config/repair';

const MINIMAL = `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
groups:
  engineering:
    - { provider: entra, id: "grp-eng" }
admins:
  groups: [engineering]
forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

describe('repairing an instance config', () => {
  it('removes the keys the schema does not know, and keeps everything else as written', () => {
    const yaml = `${MINIMAL}# The look of the instance
theme:
  template: default
  tui: true
  rounded_corners: false
brand:
  name: Acme
  wallpaper_all_themes: true
`;
    expect(() => loadInstanceConfig(yaml)).toThrow();

    const repaired = repairInstanceConfig(yaml);
    expect(repaired.removed.sort()).toEqual([
      'brand.wallpaper_all_themes',
      'theme.rounded_corners',
      'theme.tui',
    ]);
    expect(repaired.remaining).toEqual([]);
    expect(repaired.yaml).toContain('# The look of the instance');
    expect(repaired.yaml).toContain('template: default');
    expect(repaired.yaml).toContain('name: Acme');
    expect(() => loadInstanceConfig(repaired.yaml)).not.toThrow();
  });

  it('removes a value the schema rejects, so its default applies', () => {
    const repaired = repairInstanceConfig(`${MINIMAL}theme:\n  font: comic\n`);
    expect(repaired.removed).toEqual(['theme.font']);
    expect(repaired.remaining).toEqual([]);
    expect(repaired.yaml).not.toContain('theme:');
  });

  it('says what it cannot fix by removing something', () => {
    const repaired = repairInstanceConfig(MINIMAL.replace('[engineering]', '[nobody]'));
    expect(repaired.removed).toEqual([]);
    expect(repaired.remaining.join(' ')).toMatch(/nobody/);
  });
});
