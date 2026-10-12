import { elapsed, isoOf, relativeTime } from '../../src/common/time';
import { nextSetupPage, setupSteps } from '../../src/dashboard/setup/steps';
import { repoLevel, runLevel, severityLevel } from '../../src/dashboard/ui/levels';
import { dashboardNav } from '../../src/dashboard/ui/views/nav-tree/nav-tree';
import { openDashboardFolds } from '../../src/dashboard/dashboard-sections';
import { renderHelp } from '../../src/global-ui/help-markup';
import { renderTemplate } from '../../src/content-reader/views';

describe('the section list', () => {
  it('offers the log to an admin only', () => {
    expect(dashboardNav('status', true).html).toContain('href="/-/logs"');
    expect(dashboardNav('status', false).html).not.toContain('/-/logs');
  });

  it('files the log under Sync status, and opens that branch only from inside it', () => {
    const foldOf = (html: string, href: string) =>
      new RegExp(
        `<details class="spr-nav-fold" data-spr-fold="[a-z]+"( open)?>\\s*<summary[^>]*>\\s*<a href="${href}"`,
      ).exec(html);
    const onStatus = dashboardNav('status', true).html;
    expect(onStatus).toContain('spr-nav-branch');
    expect(onStatus.indexOf('href="/-/status"')).toBeLessThan(onStatus.indexOf('href="/-/logs"'));
    expect(onStatus).toMatch(/href="\/-\/status" aria-current="page"/);
    expect(onStatus.match(/aria-current/g)).toHaveLength(1);

    const onLogs = dashboardNav('logs', true).html;
    expect(onLogs).toMatch(/href="\/-\/logs" aria-current="page"/);
    expect(onLogs).not.toMatch(/href="\/-\/status" aria-current/);
    expect(onLogs.match(/aria-current/g)).toHaveLength(1);

    // Elsewhere the branch is drawn folded shut — present, so it can be opened,
    // and closed, so the column says where the reader is.
    expect(foldOf(onStatus, '/-/status')?.[1]).toBe(' open');
    expect(foldOf(onLogs, '/-/status')?.[1]).toBe(' open');
    for (const elsewhere of ['explain', 'config'] as const) {
      const html = dashboardNav(elsewhere, true).html;
      expect(foldOf(html, '/-/status')).not.toBeNull();
      expect(foldOf(html, '/-/status')?.[1]).toBeUndefined();
    }
  });

  it('draws a branch the reader left open open, and never folds the page away', () => {
    // The island records open branches in a cookie and the server draws them: an
    // island reapplying them ran after first paint, and the column flashed shut and
    // open on every navigation
    const statusFold = /<details class="spr-nav-fold" data-spr-fold="status"( open)?>/;
    const configFold = /<details class="spr-nav-fold" data-spr-fold="config"( open)?>/;

    const remembered = dashboardNav('config', true, {
      openFolds: openDashboardFolds('status,config'),
    }).html;
    expect(statusFold.exec(remembered)?.[1]).toBe(' open');

    const forgotten = dashboardNav('config', true, { openFolds: openDashboardFolds('') }).html;
    expect(statusFold.exec(forgotten)?.[1]).toBeUndefined();
    expect(configFold.exec(forgotten)?.[1]).toBe(' open');
  });

  it('reads only section ids out of the folds cookie', () => {
    expect([...openDashboardFolds('status,nope,"><script>,config')]).toEqual(['status', 'config']);
    expect(openDashboardFolds(undefined).size).toBe(0);
  });

  it('marks the section the reader is on', () => {
    const html = dashboardNav('explain', true).html;
    expect(html).toMatch(/href="\/-\/explain" aria-current="page"/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it('ships only the icons it actually renders', () => {
    for (const isAdmin of [false, true]) {
      const nav = dashboardNav('status', isAdmin);
      expect(nav.icons).toHaveLength((nav.html.match(/<li /g) ?? []).length);
    }
    expect(dashboardNav('status', false).icons.length).toBeLessThan(
      dashboardNav('status', true).icons.length,
    );
  });

  it('hides the admin-only sections from a maintainer', () => {
    const maintainer = dashboardNav('status', false).html;
    expect(maintainer).not.toContain('/-/graph');
    expect(maintainer).not.toContain('/-/logs');
    expect(maintainer).not.toContain('/-/config');
    expect(dashboardNav('status', true).html).toContain('/-/graph');
    expect(dashboardNav('status', true).html).toContain('/-/config');
  });

  it('drops the sections that can only report nothing, until there is content', () => {
    const empty = dashboardNav('config', true, {
      showSetup: false,
      hasContent: false,
    }).html;
    expect(empty).not.toContain('/-/status');
    expect(empty).not.toContain('/-/explain');
    expect(empty).not.toContain('/-/graph');
    expect(empty).toContain('/-/config');
    expect(empty).toContain('/-/connections');

    const stocked = dashboardNav('config', true, {
      showSetup: false,
      hasContent: true,
    }).html;
    for (const href of ['/-/status', '/-/explain', '/-/graph']) {
      expect(stocked).toContain(href);
    }
  });

  it('draws a hidden section when it is the page you are on', () => {
    expect(dashboardNav('graph', true, { showSetup: false, hasContent: false }).html).toContain(
      '/-/graph',
    );
  });

  it('shows only the first run, because it is the only thing worth doing yet', () => {
    // A source added during setup does not bring the reports in early
    const html = dashboardNav('config', true, {
      showSetup: true,
      hasContent: true,
    }).html;
    expect(html).toContain('/-/setup');
    for (const href of ['/-/status', '/-/explain', '/-/graph', '/-/analytics', '/-/connections']) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it('marks the step whose page you are on, and none on a page that is no step', () => {
    const configured = {
      providerShortIds: ['entra'],
      hasAdministrator: false,
      hasContentSource: false,
      hasMagicLinkProvider: false,
      hasMailTransport: false,
    };

    const onIdentity = setupSteps(configured, '/-/config/identity');
    expect(onIdentity.find((step) => step.current)?.id).toBe('provider');
    expect(onIdentity.find((step) => step.id === 'provider')?.done).toBe(true);

    // A source being added or edited is the source step, not the next undone one
    for (const path of ['/-/config/sources/github', '/-/config/sources/docs/repo-1']) {
      expect(setupSteps(configured, path).find((step) => step.current)?.id).toBe('content');
    }
    expect(setupSteps(configured, '/-/config/identity/entra').find((s) => s.current)?.id).toBe(
      'provider',
    );

    expect(setupSteps(configured, '/-/config/groups').find((step) => step.current)?.id).toBe(
      'group',
    );

    for (const path of ['/-/logs', '/-/config', '/-/config/sourcesx']) {
      expect(setupSteps(configured, path).filter((step) => step.current)).toEqual([]);
    }

    // The overview names no page, and points at the next undone step
    expect(setupSteps(configured).find((step) => step.current)?.id).toBe('content');
  });

  it('asks for a relay before the provider that needs one, and only then', () => {
    const fresh = {
      providerShortIds: [],
      hasAdministrator: false,
      hasContentSource: false,
      hasMagicLinkProvider: false,
      hasMailTransport: false,
    };

    expect(setupSteps(fresh).map((step) => step.id)).toEqual([
      'provider',
      'group',
      'content',
      'administrator',
    ]);

    const arriving = setupSteps(fresh, '/-/config/mail');
    expect(arriving.map((step) => step.id)).toEqual([
      'mail',
      'provider',
      'group',
      'content',
      'administrator',
    ]);
    expect(arriving.find((step) => step.current)?.id).toBe('mail');
    expect(arriving.find((step) => step.id === 'mail')?.done).toBe(false);

    const relayed = setupSteps({ ...fresh, hasMailTransport: true });
    expect(relayed.find((step) => step.id === 'mail')?.done).toBe(true);
    expect(relayed.find((step) => step.current)?.id).toBe('provider');

    expect(
      setupSteps({
        ...fresh,
        providerShortIds: ['links'],
        hasMagicLinkProvider: true,
      }).map((step) => step.id),
    ).toEqual(['mail', 'provider', 'group', 'content', 'administrator']);

    for (const steps of [setupSteps(fresh), arriving, relayed]) {
      expect(steps.filter((step) => step.current)).toHaveLength(1);
    }
  });

  it('hands a finished step over to the next, and only a finished one', () => {
    const fresh = {
      providerShortIds: [],
      hasAdministrator: false,
      hasContentSource: false,
      hasMagicLinkProvider: false,
      hasMailTransport: false,
    };
    const withProvider = { ...fresh, providerShortIds: ['entra'] };

    expect(nextSetupPage(fresh, withProvider, 'identity')).toBe('/-/config/sources');
    expect(nextSetupPage(fresh, withProvider, 'identity/entra')).toBe('/-/config/sources');

    expect(nextSetupPage(withProvider, withProvider, 'identity/entra')).toBeNull();

    expect(nextSetupPage(fresh, fresh, 'identity')).toBeNull();

    // `group` is a setup step, and a provider finishes it, so it hands over like any other
    expect(nextSetupPage(fresh, withProvider, 'groups')).toBe('/-/config/sources');

    const withContent = { ...withProvider, hasContentSource: true };
    expect(nextSetupPage(withProvider, withContent, 'sources/docs')).toBe('/-/setup/administrator');

    expect(nextSetupPage(fresh, { ...fresh, hasMailTransport: true }, 'mail')).toBe(
      '/-/config/identity?kind=magic-link',
    );
    expect(
      nextSetupPage(
        { ...fresh, hasMailTransport: true },
        { ...fresh, hasMailTransport: true },
        'mail',
      ),
    ).toBeNull();
    expect(nextSetupPage(fresh, { ...fresh, hasMailTransport: true }, 'notifications')).toBeNull();
  });

  it('draws that step in the column too, because the two are one flow', () => {
    const html = dashboardNav('setup', true, {
      showSetup: true,
      hasContent: false,
      showMailTransport: true,
    }).html;
    expect(html).toContain('/-/config/mail');
    expect(html.indexOf('/-/config/mail')).toBeLessThan(html.indexOf('/-/config/identity'));

    expect(dashboardNav('setup', true, { showSetup: true, hasContent: false }).html).not.toContain(
      '/-/config/mail',
    );

    const arriving = dashboardNav('config', true, {
      showSetup: true,
      hasContent: false,
      subsection: 'mail',
    }).html;
    expect(arriving).toMatch(/href="\/-\/config\/mail" aria-current="page"/);
  });

  it('opens the first run into the settings it sends you to, and hides the rest', () => {
    const html = dashboardNav('setup', true, {
      showSetup: true,
      hasContent: false,
    }).html;
    expect(html).toContain('/-/config/identity');
    expect(html).toContain('/-/config/sources');
    expect(html).toContain('/-/config/groups');
    expect(html.indexOf('/-/config/identity')).toBeLessThan(html.indexOf('/-/config/groups'));
    expect(html.indexOf('/-/config/groups')).toBeLessThan(html.indexOf('/-/config/sources'));

    expect(html.match(/href="\/-\/config\/identity"/g)).toHaveLength(1);
    expect(html).toContain('>All settings<');
  });

  it('lists becoming the administrator under Set up, and marks it on its own page', () => {
    const setup = dashboardNav('setup', true, { showSetup: true, hasContent: false }).html;
    expect(setup).toContain('href="/-/setup/administrator"');
    expect(setup.indexOf('/-/config/sources')).toBeLessThan(
      setup.indexOf('/-/setup/administrator'),
    );
    expect(setup.indexOf('/-/setup/administrator')).toBeLessThan(setup.indexOf('>All settings<'));

    const onIt = dashboardNav('setup', true, {
      showSetup: true,
      hasContent: false,
      subsection: 'administrator',
    }).html;
    expect(onIt).toMatch(/href="\/-\/setup\/administrator" aria-current="page"/);
    expect(onIt.match(/aria-current/g)).toHaveLength(1);
  });

  it('keeps a step marked while one of its members is being added or edited', () => {
    const html = dashboardNav('config', true, {
      showSetup: true,
      hasContent: false,
      subsection: 'sources/github',
    }).html;
    expect(html).toMatch(/href="\/-\/config\/sources" aria-current="true"/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it('keeps Logs and Configuration off the column, each for its own reason', () => {
    const setup = dashboardNav('setup', true, {
      showSetup: true,
      hasContent: false,
    }).html;
    expect(setup).not.toContain('/-/logs');

    const onLogs = dashboardNav('logs', true, {
      showSetup: true,
      hasContent: false,
    }).html;
    expect(onLogs).toContain('/-/logs');
    expect(onLogs).toContain('href="/-/status"');
    expect(onLogs.match(/aria-current/g)).toHaveLength(1);
    const onConfig = dashboardNav('config', true, {
      showSetup: true,
      hasContent: false,
    }).html;
    expect(onConfig.match(/href="\/-\/config"/g)).toHaveLength(1);
    expect(onConfig.match(/aria-current/g)).toHaveLength(1);
  });

  it('marks the settings page you are on, even though its section is not in the column', () => {
    const html = dashboardNav('config', true, {
      subsection: 'identity',
      showSetup: true,
      hasContent: false,
    }).html;
    expect(html).toMatch(/href="\/-\/config\/identity" aria-current="page"/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it('gives the configuration back its own branch once setup is over', () => {
    const html = dashboardNav('config', true, {
      subsection: 'identity',
      showSetup: false,
      hasContent: true,
    }).html;
    expect(html).toContain('/-/config/branding');
    expect(html).not.toContain('/-/setup');
    expect(html).not.toContain('>All settings<');
  });

  it('carries the first-run entry only while there is a first run', () => {
    expect(dashboardNav('config', true, { showSetup: true }).html).toContain('/-/setup');
    expect(dashboardNav('config', true, { showSetup: false }).html).not.toContain('/-/setup');
    expect(dashboardNav('setup', true, { showSetup: false }).html).toContain('/-/setup');
  });

  it('opens the configuration into its sections, and only there', () => {
    const inside = dashboardNav('config', true, {
      subsection: 'identity',
    }).html;
    expect(inside).toContain('spr-nav-branch');
    expect(inside).toContain('href="/-/config/identity"');
    expect(inside).toContain('href="/-/config/embedding"');
    expect(inside).not.toContain('spr-nav-toggle');

    expect(inside).toMatch(
      /<details class="spr-nav-fold" data-spr-fold="config" open>\s*<summary[^>]*>\s*<a href="\/-\/config"/,
    );

    // Elsewhere the sections are there to be unfolded, and folded shut
    const elsewhere = dashboardNav('explain', true).html;
    expect(elsewhere).toMatch(
      /<details class="spr-nav-fold" data-spr-fold="config">\s*<summary[^>]*>\s*<a href="\/-\/config"/,
    );
  });

  it('marks the section page, not its parent, when the reader is on one', () => {
    const html = dashboardNav('config', true, { subsection: 'groups' }).html;
    expect(html).toMatch(/href="\/-\/config\/groups" aria-current="page"/);
    expect(html).not.toMatch(/href="\/-\/config" aria-current/);
    expect(html.match(/aria-current/g)).toHaveLength(1);

    const overview = dashboardNav('config', true).html;
    expect(overview).toMatch(/href="\/-\/config" aria-current="page"/);
    expect(overview.match(/aria-current/g)).toHaveLength(1);
  });

  it('still ships exactly the icons it renders once the sections are open', () => {
    const nav = dashboardNav('config', true, { subsection: 'identity' });
    expect(nav.icons).toHaveLength((nav.html.match(/<li /g) ?? []).length);
  });

  it('carries no fragment-navigation hook', () => {
    expect(dashboardNav('status', true).html).not.toContain('data-tree');
  });
});

describe('the state of a repository', () => {
  it('reads a failure as a failure, whatever the clock says', () => {
    expect(repoLevel('failed', false)).toBe('fail');
    expect(repoLevel('failed', true)).toBe('fail');
  });

  it('treats silence as its own problem', () => {
    expect(repoLevel('ok', true)).toBe('warn');
    expect(repoLevel('ok', false)).toBe('ok');
  });

  it('says nothing it does not know', () => {
    expect(repoLevel('never', false)).toBe('idle');
    expect(runLevel('running')).toBe('idle');
    expect(severityLevel('reject')).toBe('fail');
    expect(severityLevel('warn')).toBe('warn');
    expect(severityLevel('info')).toBe('idle');
  });
});

describe('times', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);

  it('answers the question actually being asked', () => {
    expect(ago(3_000)).toBe('3 seconds ago');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(3 * 3_600_000)).toBe('3 hours ago');
    expect(ago(2 * 86_400_000)).toBe('2 days ago');
    expect(ago(400 * 86_400_000)).toBe('1 year ago');
  });

  it('does not report a clock skew as a time traveller', () => {
    expect(relativeTime(new Date(now.getTime() + 2_000), now)).toBe('just now');
  });

  it('has a word for a repository that has never synced', () => {
    expect(relativeTime(null, now)).toBe('never');
  });

  it('measures a run, including one still going', () => {
    expect(elapsed('2026-08-23T12:00:00Z', '2026-08-23T12:00:00.400Z')).toBe('400 ms');
    expect(elapsed('2026-08-23T12:00:00Z', '2026-08-23T12:00:04.500Z')).toBe('4.5 s');
    expect(elapsed('2026-08-23T12:00:00Z', '2026-08-23T12:03:00Z')).toBe('3 min');
    expect(elapsed(new Date(Date.now() - 2_000), null)).toBe('2.0 s');
  });

  it('keeps the machine-readable instant for the attribute that wants one', () => {
    expect(isoOf(new Date('2026-08-23T12:00:00Z'))).toBe('2026-08-23T12:00:00.000Z');
    expect(isoOf(null)).toBe('');
    expect(isoOf('not a date')).toBe('');
  });
});

describe('group reach on the explain page', () => {
  const page = (groupSizes: unknown): string =>
    renderTemplate('dashboard/ui/views/path-access-check', {
      path: '/handbook/pricing',
      external_mark: '<svg class="spr-external"></svg>',
      result: {
        found: true,
        kind: 'page',
        slugPath: 'handbook/pricing',
        principals: ['group:commercial'],
        indexable: true,
        chain: [],
        droppedGrants: [],
        groupSizes,
      },
    });

  it('states the count as a ceiling and offers the directory as the place to look', () => {
    const html = page([
      {
        name: 'commercial',
        size: '214',
        directoryUrl: 'https://portal.azure.com/#view/x/groupId/g',
      },
    ]);
    expect(html).toContain('up to 214 readers');
    expect(html).toContain('href="https://portal.azure.com/#view/x/groupId/g"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('(external link)');
  });

  it('says a size is not known rather than drawing it as none', () => {
    const html = page([{ name: 'commercial', size: 'unknown', directoryUrl: '' }]);
    expect(html).toContain('not known');
    expect(html).not.toContain('up to');
    expect(html).not.toContain('portal.azure.com');
  });

  it('draws nothing at all for a maintainer, who is not handed the column', () => {
    expect(page(null)).not.toContain('Group reach');
  });
});

describe('a live check beside a control', () => {
  const page = (status: unknown, checkHref?: string): string =>
    renderTemplate('dashboard/ui/views/config-section', {
      section_id: 'identity/entra',
      section_title: 'entra',
      badge_icons: { check: '<svg class="spr-icon" data-icon="check"></svg>' },
      section: {
        id: 'identity/entra',
        title: 'entra',
        parent: 'identity',
        blurb: '',
        blurbHtml: '',
        fields: [
          {
            path: 'auth.providers.entra.directory.type',
            schemaPath: 'auth.providers.<key>.directory.type',
            label: 'Directory lookup',
            kind: 'select',
            value: 'graph',
            checked: false,
            values: [],
            options: [
              { value: '', label: 'Not configured' },
              { value: 'graph', label: 'Microsoft Graph' },
            ],
            help: '',
            helpHtml: '',
            placeholder: '',
            secretHidden: false,
            rows: 4,
            fallback: undefined,
            stored: '',
            storedHash: '',
            thumbHref: '',
            attached: [],
            inapplicable: false,
            pattern: '',
            linkHtml: '',
            status,
            checkHref,
          },
        ],
        entries: [],
        cards: [],
        addOps: [],
      },
      shape: [],
      editable: true,
      config_path: null,
      unreadable: null,
      unparseable: null,
      saved: null,
      pending: false,
      creating: false,
      running_version: 1,
      editing_version: 1,
      skipped: [],
      waiting_on: [],
      error: null,
      problems: [],
      verdict: null,
    });

  it('draws the mark and keeps the word beside it', () => {
    const html = page({
      level: 'ok',
      icon: 'check',
      label: 'Connected',
      detail: '',
    });
    expect(html).toContain('class="spr-note spr-note-ok"');
    expect(html).toContain('data-icon="check"');
    expect(html).toContain('Connected');
  });

  it('says why it failed, because the reason names the screen to go to', () => {
    const html = page({
      level: 'fail',
      icon: 'circle-alert',
      label: 'Not connected',
      detail: 'status 403: the app registration needs admin consent',
    });
    expect(html).toContain('class="spr-note spr-note-fail"');
    expect(html).toContain('Not connected: status 403: the app registration needs admin consent');
    expect(html).not.toContain('data-icon');
  });

  it('draws nothing where nothing was checked', () => {
    const html = page(undefined);
    expect(html).not.toContain('spr-note-ok');
    expect(html).not.toContain('spr-note-fail');
    expect(html).not.toContain('data-spr-check');
  });

  it('offers the check as a link where the answer has not been asked for', () => {
    const html = page(undefined, '/-/config/identity/entra?check=1');

    expect(html).toContain('data-spr-check="/-/config/identity/entra?check=1"');
    expect(html).toContain('<a href="/-/config/identity/entra?check=1">Check the connection</a>');
    expect(html).toContain('data-spr-check-at="auth.providers.entra.directory.type"');
    expect(html).toContain('data-spr-check-mark="ok" hidden');
    expect(html).toContain('data-spr-check-mark="fail" hidden');
  });

  it('draws the answer instead of the offer once there is one', () => {
    const html = page(
      { level: 'ok', icon: 'check', label: 'Connected', detail: '' },
      '/-/config/identity/entra?check=1',
    );

    expect(html).toContain('Connected');
    expect(html).not.toContain('Check the connection');
  });
});

describe('the head of a section page', () => {
  const page = (blurb: string): string =>
    renderTemplate('dashboard/ui/views/config-section', {
      section_id: 'branding',
      section_title: 'Branding',
      section: {
        id: 'branding',
        title: 'Branding',
        parent: null,
        blurb,
        blurbHtml: renderHelp(blurb),
        fields: [],
        entries: [],
        cards: [],
        addOps: [],
      },
      shape: [],
      editable: true,
      config_path: null,
      unreadable: null,
      unparseable: null,
      saved: null,
      pending: false,
      creating: false,
      running_version: 1,
      editing_version: 1,
      skipped: [],
      waiting_on: [],
      error: null,
      problems: [],
      verdict: null,
    });

  it('prints the sentence when there is one', () => {
    const html = page('What this instance is called.');
    expect(html).toContain('<h1>Branding</h1>');
    expect(html).toContain('class="spr-section-blurb"');
    expect(html).toContain('What this instance is called.');
  });

  it('formats it the way the help beside a control is formatted', () => {
    const html = page('What `brand.name` is called.');
    expect(html).toContain('<code>brand.name</code>');
  });

  it('prints no paragraph at all when there is not', () => {
    const html = page('');
    expect(html).toContain('<h1>Branding</h1>');
    expect(html).not.toContain('spr-section-blurb');
  });

  it('carries no breadcrumb, because its trail is one link', () => {
    expect(page('')).not.toContain('spr-crumbs');
  });
});
