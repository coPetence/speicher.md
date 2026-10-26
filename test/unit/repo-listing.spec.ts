import { renderTemplate } from '../../src/content-reader/views';

function frontPage(data: { isAdmin: boolean; hasContentSource: boolean }): string {
  return renderTemplate('content-reader/views/repo-listing', {
    authenticated: true,
    is_admin: data.isAdmin,
    has_content_source: data.hasContentSource,
    empty_art: '<svg class="spr-empty-art"></svg>',
    repos: [],
  });
}

describe('the front page without a repository', () => {
  it('sends an administrator without a content source to add one', () => {
    const page = frontPage({ isAdmin: true, hasContentSource: false });
    expect(page).toContain('<div class="spr-empty-state spr-empty-state-page spr-repos-empty">');
    expect(page).toContain('<svg class="spr-empty-art">');
    expect(page).toContain('<h1>No repositories yet</h1>');
    expect(page).toContain('href="/-/config/sources"');
    expect(page).not.toContain('<h1>Speicher</h1>');
  });

  it('sends an administrator with a content source to the sync status', () => {
    const page = frontPage({ isAdmin: true, hasContentSource: true });
    expect(page).toContain('<h1>No repositories yet</h1>');
    expect(page).toContain('href="/-/status"');
    expect(page).not.toContain('href="/-/config/sources"');
  });

  it('tells a reader nothing is shared with them, without linking the dashboard', () => {
    const page = frontPage({ isAdmin: false, hasContentSource: true });
    expect(page).toContain('<h1>No documentation yet</h1>');
    expect(page).toContain('No repository on this instance is shared with you yet.');
    expect(page).not.toContain('href="/-/');
  });
});
