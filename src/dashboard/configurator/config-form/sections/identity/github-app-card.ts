import {
  GITHUB_CALLBACK_PATH,
  githubCallbackUrl,
  publicUrl,
} from '../../../../../auth/callback-url';
import { githubAppLinks } from '../../../../../forge/github/app-links';
import { githubHosts } from '../../../../../forge/github/hosts';

import type { CardItem, Obj } from '../../config-fields';
import {
  SECRET_HELP,
  at,
  choice,
  choiceName,
  copyValue,
  githubAppLinksItem,
  githubAppManifest,
  secretField,
  textField,
} from '../../config-fields';
import { scalarString } from '../../document';
import { memberSectionId } from '../../members';
import type { Card } from '../../model';

const GITHUB_APP_SIGN_IN_NOTE =
  'This will create a GitHub App, not an OAuth App. Only members of the organization you create the App on will be able to sign in, and if you create it on your personal account, only you will be able to sign in. To let every GitHub user sign in, create an OAuth App on GitHub and enter its details manually. Find out more in our [documentation](https://docs.speicher.md/access/identity/github).';

/**
 * providerAppSetupName returns the name of the switch between creating a provider's App on GitHub and entering its details manually.
 *
 * @param id the provider's key
 */
function providerAppSetupName(id: string): string {
  return `auth.providers.${id}.app`;
}

/**
 * hasProviderApp returns whether a GitHub provider has an App, which is the case once its client id or secret is set.
 *
 * @param root the configuration document
 * @param id the provider's key
 */
export function hasProviderApp(root: Obj, id: string): boolean {
  return ['client_id', 'client_secret'].some(
    (key) => scalarString(at(root, ['auth', 'providers', id, key])) !== '',
  );
}

/**
 * waitsForProviderApp returns a card of a GitHub provider that, until the provider has an App, is shown only while the App's details are entered manually.
 *
 * @param root the configuration document
 * @param id the provider's key
 * @param card the card
 */
export function waitsForProviderApp(root: Obj, id: string, card: Card): Card {
  if (hasProviderApp(root, id)) return card;
  // The App card's switch opens on Create on GitHub
  return {
    ...card,
    shownWith: choiceName(providerAppSetupName(id)),
    shownWhen: 'manual',
    hidden: true,
  };
}

/**
 * storedAppLinks returns the links to the settings page and the installation page of a GitHub provider's App.
 * It returns null if Speicher did not create the App, or if the client id now names another App.
 *
 * @param root the configuration document
 * @param id the provider's key
 */
function storedAppLinks(root: Obj, id: string): CardItem | null {
  const base = ['auth', 'providers', id];
  const app = at(root, [...base, 'app']) as Obj | undefined;
  const slug = scalarString(app?.slug);
  const clientId = scalarString(at(root, [...base, 'client_id']));
  if (!app || slug === '' || scalarString(app.client_id) !== clientId) return null;

  const { web } = githubHosts(scalarString(at(root, [...base, 'base_url'])));
  return githubAppLinksItem(
    githubAppLinks(web, slug, {
      accountName: scalarString(app.owner_account),
      isOrganization: app.owner_is_organization === true,
    }),
  );
}

/**
 * githubAppCard builds the card holding the client id and secret of a GitHub provider's App.
 *
 * @param root the configuration document
 * @param id the provider's key
 */
export function githubAppCard(root: Obj, id: string): Card {
  const base = ['auth', 'providers', id];
  const p = (key: string) => `auth.providers.<key>.${key}`;

  const credentials: CardItem[] = [
    textField(root, [...base, 'client_id'], p('client_id'), 'Client id', { required: true }),
    secretField(root, [...base, 'client_secret'], p('client_secret'), 'Client secret', {
      help: SECRET_HELP,
      required: true,
    }),
  ];

  const addresses: CardItem[] = [
    copyValue(
      'Homepage URL',
      publicUrl() ?? '/',
      'Enter this as the **Homepage URL** of your OAuth App or GitHub App.',
    ),
    copyValue(
      'Authorization callback URL',
      githubCallbackUrl() ?? GITHUB_CALLBACK_PATH,
      'Enter this as the **Authorization callback URL** of your OAuth App, or as the **Callback URL** of your GitHub App.',
      { startsRow: false },
    ),
  ];

  // Once the provider has an App, the card shows only its client id and secret, and the links to the App
  if (hasProviderApp(root, id)) {
    const links = storedAppLinks(root, id);
    return {
      title: 'GitHub App',
      required: true,
      subtitle:
        'You can find these values in the settings of your OAuth App or GitHub App, under Developer settings.',
      removeOp: null,
      notes: [],
      cards: [],
      addOps: [],
      items: links ? [...credentials, links] : credentials,
    };
  }

  const manifest = githubAppManifest(
    `/-/config/${memberSectionId('identity', id)}/github-app/manifest`,
    '',
    GITHUB_APP_SIGN_IN_NOTE,
  );
  return {
    title: 'GitHub App',
    required: true,
    subtitle: '',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      choice(
        'How the App is set up',
        [
          { value: 'create', label: 'Create on GitHub', items: [manifest] },
          { value: 'manual', label: 'Enter manually', items: [...credentials, ...addresses] },
        ],
        { name: providerAppSetupName(id), selected: 'create' },
      ),
    ],
  };
}
