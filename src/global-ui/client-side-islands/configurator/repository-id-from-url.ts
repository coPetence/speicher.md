/**
 * Fills in the id of a repository on a plain git remote while its remote URL is typed
 * or pasted. The id is the name of the repository in the URL, as the server fills it in
 * for a repository without an id. An id the user typed is kept
 */
import { repositoryName } from '../../../forge/remote-url';
import { configForm, reportScriptedEdit } from './config-form-handle';

// The remote URL of a repository, e.g. `forges.onprem.repos.0.url`; the first group is
// the path of the repository
const REMOTE_URL = /^(forges\.[^.]+\.repos\.\d+)\.url$/;

export function mountRepositoryIds(): void {
  const form = configForm();
  if (!form) return;

  for (const url of form.querySelectorAll<HTMLInputElement>('input[name$=".url"]')) {
    const repository = REMOTE_URL.exec(url.name)?.[1];
    const id = repository
      ? form.querySelector<HTMLInputElement>(`input[name="${repository}.id"]`)
      : null;
    if (!id) continue;

    // The id for a URL, or an empty string if the name is not a valid id
    const idOf = (value: string): string => {
      const name = repositoryName(value);
      return id.pattern === '' || new RegExp(`^(?:${id.pattern})$`, 'v').test(name) ? name : '';
    };

    // The id that was filled in, by the server or by this island, rather than typed
    let filled = id.value === idOf(url.value) ? id.value : null;

    url.addEventListener('input', () => {
      if (id.value !== '' && id.value !== filled) return;
      const next = idOf(url.value);
      if (next === id.value) return;
      id.value = next;
      filled = next;
      reportScriptedEdit(id);
    });
  }
}
