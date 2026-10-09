/**
 * Git remote repository card
 */

import { scalarString } from '../../document';
import type { Field, Obj } from '../../config-fields';
import {
  SECRET_HELP,
  at,
  durationField,
  multilineField,
  secretField,
  textField,
} from '../../config-fields';
import type { Card } from '../../model';

const REPO_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,99}';
const REPO_ID_HINT =
  'Letters, digits, dots, underscores and hyphens, starting with a letter or digit. Up to 100 characters.';

export function repoCard(root: Obj, forgeId: string, index: number): Card {
  const base = ['forges', forgeId, 'repos', index];
  const p = (key: string) => `forges.<key>.repos.<index>.${key}`;
  const url = scalarString(at(root, [...base, 'url']));
  const ssh = url.startsWith('ssh://');

  const fields: Field[] = [
    textField(root, [...base, 'id'], p('id'), 'Repository id', {
      pattern: REPO_ID_PATTERN,
      patternHint: REPO_ID_HINT,
      help:
        'Chosen here, not derived from the URL — so moving the remote to a new ' +
        'host does not read as a different repository and break every link. It ' +
        'names this repository’s mirror on disk, so it starts with a letter or a ' +
        'digit; it is not the URL, which is the slug below.',
    }),
    textField(root, [...base, 'url'], p('url'), 'Remote URL', {
      placeholder: 'ssh://git@example.com/team/docs.git',
      help: 'ssh:// with a deploy key, or https:// with a token. Nothing else is fetched. The path before the repository name is its owner, for example `team` in `ssh://git@example.com/team/docs.git`.',
    }),
    textField(root, [...base, 'slug'], p('slug'), 'URL slug', {
      help: 'Defaults to the id. Changing it leaves the old path serving a redirect.',
    }),
    textField(root, [...base, 'branch'], p('branch'), 'Branch', {
      placeholder: 'main',
    }),
  ];

  if (ssh) {
    fields.push(
      secretField(root, [...base, 'deploy_key'], p('deploy_key'), 'Deploy key', {
        help: SECRET_HELP,
      }),
      multilineField(root, [...base, 'known_hosts'], p('known_hosts'), 'Known hosts', {
        help: 'Overrides the source-wide pin for this repository.',
        rows: 3,
      }),
    );
  } else {
    fields.push(
      secretField(root, [...base, 'token'], p('token'), 'Access token', {
        help: SECRET_HELP,
      }),
      textField(root, [...base, 'username'], p('username'), 'Username', {
        fallback: 'x-access-token',
        placeholder: 'x-access-token',
      }),
    );
  }

  fields.push(
    durationField(root, [...base, 'poll_interval'], p('poll_interval'), 'Poll interval', {
      help: 'Overrides the source-wide interval for this repository.',
    }),
  );

  const id = scalarString(at(root, [...base, 'id']));

  return {
    // The one card whose heading is a document key: it is the mirror directory's
    // name and what `speicher sync-repo-content <id>` takes, so it is a string an operator
    // pastes. An entry with no id yet is counted instead, and that is prose.
    title: id || `Repository ${index + 1}`,
    titleIsKey: id !== '',
    subtitle: url,
    removeOp: `remove:forges.${forgeId}.repos.${index}`,
    items: fields,
    cards: [],
    addOps: [],
    notes: [],
  };
}
