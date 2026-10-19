import { PagerItem, pagerOf } from '../../src/global-ui/components/pager/pager';

const href = (page: number) => `/list?page=${page}`;

// The items as they read: numbers, the current one in brackets, gaps as an ellipsis
function read(items: PagerItem[]): string {
  return items
    .map((item) =>
      item.kind === 'gap' ? '…' : item.current ? `[${item.number}]` : String(item.number),
    )
    .join(' ');
}

describe('the pager', () => {
  it('shows every page of a short list', () => {
    expect(read(pagerOf(2, 3, href).items)).toBe('1 [2] 3');
    expect(read(pagerOf(1, 1, href).items)).toBe('[1]');
  });

  it('keeps the first and the last page, and the neighbours of the current one', () => {
    expect(read(pagerOf(6, 12, href).items)).toBe('1 … 5 [6] 7 … 12');
    expect(read(pagerOf(1, 12, href).items)).toBe('[1] 2 … 12');
    expect(read(pagerOf(12, 12, href).items)).toBe('1 … 11 [12]');
  });

  it('shows a single skipped page instead of an ellipsis for it', () => {
    expect(read(pagerOf(4, 12, href).items)).toBe('1 2 3 [4] 5 … 12');
  });

  it('links the neighbouring pages, and none past either end', () => {
    expect(pagerOf(1, 3, href)).toMatchObject({ previous: null, next: '/list?page=2' });
    expect(pagerOf(3, 3, href)).toMatchObject({ previous: '/list?page=2', next: null });
  });
});
