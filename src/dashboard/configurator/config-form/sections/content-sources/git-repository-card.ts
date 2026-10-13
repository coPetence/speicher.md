/**
 * Git remote repository card
 */

import type { CardItem, Obj } from '../../config-fields';
import {
  SECRET_HELP,
  at,
  choice,
  durationField,
  secretField,
  textField,
} from '../../config-fields';
import { scalarString } from '../../document';
import type { Card } from '../../model';
import { SCP_FORM, repositoryName } from '../../../../../forge/remote-url';

const REPO_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,99}';
const REPO_ID_HINT =
  'Letters, digits, dots, underscores and hyphens, starting with a letter or digit. Up to 100 characters.';
const ACCESS_TOKEN_HELP =
  'Used to fetch this repository over HTTPS. It needs read access to the contents of the repository.';
const DEPLOY_KEY_HELP =
  'The private SSH key used to fetch this repository. The key must not have a passphrase. To create a key, run `ssh-keygen -t ed25519 -N "" -f speicher-deploy-key`. Paste the content of `speicher-deploy-key` here, or choose the file with the button or drop it onto the field, and add `speicher-deploy-key.pub` to the repository as a read-only deploy key, on GitHub you can do this under **Settings → Deploy keys**.';

/**
 * defaultRepositoryId returns the name of the repository in a remote URL as a repository id. It returns an empty string if the name is not a valid repository id.
 * @param url the remote URL of the repository
 */
export function defaultRepositoryId(url: string): string {
  const name = repositoryName(url);
  return new RegExp(`^${REPO_ID_PATTERN}$`).test(name) ? name : '';
}

export function repoCard(root: Obj, forgeId: string, index: number): Card {
  const base = ['forges', forgeId, 'repos', index];
  const p = (key: string) => `forges.<key>.repos.<index>.${key}`;
  const url = scalarString(at(root, [...base, 'url']));
  const id = scalarString(at(root, [...base, 'id']));

  const urlField = textField(root, [...base, 'url'], p('url'), 'Remote URL', {
    help: 'ssh:// with a deploy key, or https:// with a token. Nothing else is fetched. The path before the repository name is its owner, for example `team` in `ssh://git@example.com/team/docs.git`.',
    wide: true,
    required: true,
  });

  const items: CardItem[] = [
    {
      ...textField(root, [...base, 'id'], p('id'), 'Repository id', {
        pattern: REPO_ID_PATTERN,
        patternHint: REPO_ID_HINT,
        help: 'The repository id identifies this repository within the content source. It is used as the URL slug when the URL slug field is empty. If you leave it empty, Speicher uses the name of the repository in the remote URL when you save, for example `docs` for `ssh://git@example.com/team/docs.git`.',
      }),
      // A repository without an id gets the name of the repository in its remote URL.
      // repository-id-from-url.ts fills it in the same way while the URL is typed
      value: id || defaultRepositoryId(url),
    },
    textField(root, [...base, 'branch'], p('branch'), 'Branch', {
      placeholder: 'main',
    }),
    choice(
      'Transport',
      [
        {
          value: 'https',
          label: 'HTTPS',
          prefix: 'https://',
          placeholder: 'https://example.com/team/docs.git',
          prefixHint: 'With HTTPS selected, the remote URL starts with https://.',
          items: [
            secretField(root, [...base, 'token'], p('token'), 'Access token', {
              help: `${ACCESS_TOKEN_HELP}\n\n${SECRET_HELP}`,
              startsRow: true,
              required: true,
            }),
            textField(root, [...base, 'username'], p('username'), 'Username', {
              fallback: 'x-access-token',
              placeholder: 'x-access-token',
            }),
          ],
        },
        {
          value: 'ssh',
          label: 'SSH',
          prefix: 'ssh://',
          // An ssh:// URL, or the scp form git hosts show
          pattern: `ssh://.*|${SCP_FORM}`,
          placeholder: 'ssh://git@example.com/team/docs.git',
          prefixHint:
            'With SSH selected, the remote URL starts with ssh://, or has the form git@example.com:team/docs.git.',
          items: [
            secretField(root, [...base, 'deploy_key'], p('deploy_key'), 'Deploy key', {
              help: `${DEPLOY_KEY_HELP}\n\n${SECRET_HELP}`,
              required: true,
              upload: {
                // Keys from `ssh-keygen` have no extension, so every file can be picked
                accept: '',
                content: 'ssh-private-key',
                label: 'Choose key file…',
                dropLabel: 'Drop the private key file here',
              },
            }),
          ],
        },
      ],
      urlField,
    ),
    textField(root, [...base, 'slug'], p('slug'), 'URL slug', {
      help: 'How the repository is named in the URLs of this content source. Leave it empty to use the repository id instead.',
      advanced: true,
    }),
    durationField(root, [...base, 'poll_interval'], p('poll_interval'), 'Poll interval', {
      help: 'Overrides the source-wide interval for this repository.',
      advanced: true,
    }),
  ];

  return {
    title: id || `Repository ${index + 1}`,
    titleIsKey: id !== '',
    subtitle: url,
    removeOp: `remove:forges.${forgeId}.repos.${index}`,
    items,
    cards: [],
    addOps: [],
    notes: [],
  };
}
