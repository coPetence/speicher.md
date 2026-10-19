import { REPO_STATES, RepoState, RepoStatus } from './status.types';

export function repoMatchText(repo: RepoStatus): string {
  return [repo.namespace, repo.slug, repo.forge_key, repo.forge_type]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

export const PAGE_RANGES = ['none', '1-9', '10-99', '100+'] as const;
export type PageRange = (typeof PAGE_RANGES)[number];

export function pageRangeOf(pages: number): PageRange {
  if (pages === 0) return 'none';
  if (pages < 10) return '1-9';
  if (pages < 100) return '10-99';
  return '100+';
}

export interface RepoFilter {
  state: RepoState[];
  owner: string[];
  source: string[];
  pages: PageRange[];
}

export const FILTER_DIMENSIONS = ['state', 'owner', 'source', 'pages'] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

export const DEFAULT_REPO_FILTER: RepoFilter = {
  state: REPO_STATES.filter((state) => state !== 'unpublished'),
  owner: [],
  source: [],
  pages: [],
};

const MAX_VALUES = 200;
const MAX_VALUE_LENGTH = 200;

export function repoFilterFrom(params: Record<string, unknown>): RepoFilter | null {
  if (!['f', ...FILTER_DIMENSIONS].some((key) => params[key] !== undefined)) return null;
  const values = (key: FilterDimension): string[] =>
    [params[key]]
      .flat()
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .filter((value) => value.length <= MAX_VALUE_LENGTH)
      .slice(0, MAX_VALUES);
  return {
    state: values('state').filter((value): value is RepoState =>
      (REPO_STATES as readonly string[]).includes(value),
    ),
    owner: [...new Set(values('owner'))],
    source: [...new Set(values('source'))],
    pages: values('pages').filter((value): value is PageRange =>
      (PAGE_RANGES as readonly string[]).includes(value),
    ),
  };
}

export function repoFilterQuery(filter: RepoFilter): string {
  const params = new URLSearchParams({ f: '1' });
  for (const key of FILTER_DIMENSIONS) {
    for (const value of filter[key]) params.append(key, value);
  }
  return params.toString();
}

export function repoFilterFromQuery(query: string | undefined): RepoFilter | null {
  if (!query) return null;
  const params: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) (params[key] ??= []).push(value);
  return repoFilterFrom(params);
}

export interface FacetOption {
  value: string;
  count: number;
}

export function facetsOf(repo: RepoStatus): Record<FilterDimension, string> {
  return {
    state: repo.state,
    owner: repo.namespace,
    source: repo.forge_key ?? '',
    pages: pageRangeOf(repo.documents),
  };
}

export function facetOptions(repos: RepoStatus[]): Record<FilterDimension, FacetOption[]> {
  const rows = repos.map(facetsOf);
  const count = (key: FilterDimension, value: string) =>
    rows.filter((row) => row[key] === value).length;
  const named = (key: FilterDimension): FacetOption[] =>
    [...new Set(rows.map((row) => row[key]))]
      .filter((value) => value !== '')
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, count: count(key, value) }));
  return {
    state: REPO_STATES.map((value) => ({ value, count: count('state', value) })),
    owner: named('owner'),
    source: named('source'),
    pages: PAGE_RANGES.map((value) => ({ value, count: count('pages', value) })),
  };
}

export function matchesFilter(repo: RepoStatus, filter: RepoFilter): boolean {
  const facets = facetsOf(repo);
  return FILTER_DIMENSIONS.every(
    (key) => filter[key].length === 0 || (filter[key] as string[]).includes(facets[key]),
  );
}
