import { renderComponent } from '../../src/content-reader/views';
import type { CheckRow } from '../../src/dashboard/configurator/config-page/payloads';
import {
  AddRepositorySource,
  RepositoryTableRow,
  addRepositorySources,
} from '../../src/dashboard/setup/repository-table';

const row = (name: string, source: string): RepositoryTableRow => ({
  key: name,
  name,
  href: `https://github.com/${name}`,
  status_href: null,
  synced: null,
  source,
  file: { level: 'idle', label: 'missing' },
  access: null,
  groups: null,
  sync: { state: 'unpublished', activity: null, last_error: null, documents: 0 },
  readable: false,
});

const check = (name: string): CheckRow => ({
  name,
  href: `https://github.com/${name}`,
  state: 'unpublished',
  text: 'Not published: it has no `.speicher.yaml` yet',
  create_href: '/create',
  create_action: '/post',
});

const panel = (sources: AddRepositorySource[]) =>
  renderComponent('@add-repository-panel', {
    sources,
    checkHref: '/-/repositories?check=1',
    addIcon: '+',
    editIcon: '',
    externalIcon: '',
    syncingIcon: '',
    checkIcons: {},
  });

const source = (id: string, github: boolean, found: CheckRow[] = []) =>
  addRepositorySources(
    [{ id, github, installation: null }],
    found.map((each) => row(each.name, id)),
    new Map([[id, found]]),
  )[0];

describe('a row of a checked repository', () => {
  const edit = 'https://github.com/acme/wiki/edit/main/.speicher.yaml';
  const present: CheckRow = {
    name: 'acme/wiki',
    href: 'https://github.com/acme/wiki',
    state: 'ready',
    text: 'Readable by staff',
    edit_href: edit,
  };

  it('offers to edit a file that is present, as the table does in the add modal', () => {
    const html = panel([source('gh', true, [present])]);

    expect(html).toMatch(
      /spr-setup-file-action" href="[^"]*\/edit\/main\/\.speicher\.yaml" target="_blank"[^>]*>Edit<\/a>/,
    );
    expect(html).not.toContain('>+Create');
  });

  it('offers to edit it in the check of a source too', () => {
    const html = renderComponent('@check-panel/row', { repo: present, icon: '' });

    expect(html).toContain(`href="${edit}" target="_blank"`);
    expect(html).toContain('Edit .speicher.yaml');
  });

  it('offers nothing to edit when there is no file on the root of the repository', () => {
    const repo = { ...present, edit_href: undefined };
    const html = renderComponent('@check-panel/row', { repo, icon: '' });

    expect(html).not.toContain('Edit');
  });
});

describe('the sources of the modal that adds a repository', () => {
  it('knows the repositories of each source, whatever the filter of the table', () => {
    const [github, git] = addRepositorySources(
      [
        { id: 'gh', github: true, installation: null },
        { id: 'onprem', github: false, installation: null },
      ],
      [row('acme/handbook', 'gh')],
      new Map([['gh', [check('acme/Handbook')]]]),
    );

    expect(github.known).toEqual(['acme/handbook']);
    expect(github.found.map((each) => each.key)).toEqual(['acme/handbook']);
    expect(git.known).toEqual([]);
    expect(git.found).toEqual([]);
    expect(git.config_href).toBe('/-/config/sources/onprem');
  });
});

describe('the modal that adds a repository', () => {
  it('leads a plain git remote to its page, with nothing to open on GitHub', () => {
    const html = panel([source('onprem', false)]);

    expect(html).toMatch(/href="\/-\/config\/sources\/onprem">Open the content source/);
    expect(html).not.toContain('data-spr-add-open');
  });

  it('leads a GitHub source without an installation to its page', () => {
    const html = panel([source('gh', true)]);

    expect(html).toMatch(/href="\/-\/config\/sources\/gh">Open the content source/);
  });

  it('says it is still looking while GitHub was not asked, and offers nothing yet', () => {
    const [pending] = addRepositorySources([{ id: 'gh', github: true }], [], new Map());
    const html = panel([pending]);

    expect(html).toContain('data-spr-add-pending');
    expect(html).toContain('Looking up the GitHub App…');
    expect(html).not.toContain('could not find');
    expect(html).not.toContain('Open the content source');
    expect(html).not.toContain('data-spr-add-open');
  });

  it('tells a source without an installation apart from one still being looked up', () => {
    const html = panel([source('gh', true)]);

    expect(html).toContain('could not find an installation');
    expect(html).not.toContain('data-spr-add-pending');
  });

  it('has no source to pick when there is only one', () => {
    expect(panel([source('gh', true)])).not.toContain('data-spr-add-source-pick');
  });

  it('shows the first of several sources, with a choice between them', () => {
    const html = panel([source('gh', true), source('onprem', false)]);

    expect(html).toContain('data-spr-add-source-pick');
    expect(html).toMatch(/data-spr-add-source="gh"[^>]*(?<!hidden)>/);
    expect(html).toMatch(/data-spr-add-source="onprem"[^>]* hidden>/);
  });

  it('starts on its first screen, with the rows of the second ready to be shown', () => {
    const html = panel([source('gh', true, [check('acme/wiki')])]);

    expect(html).toMatch(/data-spr-add-result hidden>/);
    expect(html).toMatch(/<template data-spr-add-rows>[\s\S]*class="spr-check-row/);
    expect(html).toContain('data-spr-add-key="acme/wiki"');
    expect(html).toContain('data-spr-config-file-action="/post"');
    expect(html).toContain('data-spr-config-file-repository="acme/wiki"');
    expect(html).toContain('title="Create .speicher.yaml"');
    expect(html).toMatch(/spr-setup-file-action[^>]*>\+Create<\/a>/);
  });
});
