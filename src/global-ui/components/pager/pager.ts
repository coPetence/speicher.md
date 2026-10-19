export type PagerItem =
  | { kind: 'page'; number: number; href: string; current: boolean }
  | { kind: 'gap' };

export interface Pager {
  previous: string | null;
  next: string | null;
  items: PagerItem[];
}

export function pagerOf(page: number, pages: number, hrefOf: (page: number) => string): Pager {
  const shown = new Set([1, pages, page - 1, page, page + 1]);
  const numbers = [...shown].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

  const items: PagerItem[] = [];
  numbers.forEach((number, index) => {
    const before = numbers[index - 1];
    if (before !== undefined && number - before === 2) {
      items.push(pageItem(before + 1, page, hrefOf));
    } else if (before !== undefined && number - before > 2) {
      items.push({ kind: 'gap' });
    }
    items.push(pageItem(number, page, hrefOf));
  });

  return {
    previous: page > 1 ? hrefOf(page - 1) : null,
    next: page < pages ? hrefOf(page + 1) : null,
    items,
  };
}

function pageItem(number: number, page: number, hrefOf: (page: number) => string): PagerItem {
  return { kind: 'page', number, href: hrefOf(number), current: number === page };
}
