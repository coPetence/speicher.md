import { RepoStatus } from './status.types';

export const REPO_SORTS = ['name', 'pages-desc', 'pages-asc'] as const;
export type RepoSort = (typeof REPO_SORTS)[number];

export function repoSortFrom(value: unknown): RepoSort {
  return (REPO_SORTS as readonly unknown[]).includes(value) ? (value as RepoSort) : 'name';
}

export function sortRepos(repos: RepoStatus[], sort: RepoSort): RepoStatus[] {
  if (sort === 'name') return repos;
  const direction = sort === 'pages-desc' ? -1 : 1;
  return [...repos].sort((a, b) => direction * (a.documents - b.documents));
}
