export type WalkthroughPreview =
  | 'idp-sign-in'
  | 'idp-kinds'
  | 'idp-github'
  | 'speicher-yaml'
  | 'group-add'
  | 'group-provider'
  | 'group-email'
  | 'group-members'
  | 'source-repositories'
  | 'source-kinds'
  | 'source-account'
  | 'source-install'
  | 'repository-access'
  | 'repository-folders'
  | 'repository-sync';

export interface WalkthroughSlide {
  title: string;
  // Markdown
  text: string;
  // A list under the text, each point in markdown
  points?: string[];
  preview: WalkthroughPreview;
}

export interface Walkthrough {
  // The config section whose page it explains, and the key of the cookie that says it was shown
  id: string;
  title: string;
  slides: WalkthroughSlide[];
}

const WALKTHROUGHS: Walkthrough[] = [
  {
    id: 'identity',
    title: 'How signing in works',
    slides: [
      {
        title: 'What is an identity provider?',
        text: 'An identity provider is a service from a third party that authenticates a user, for example GitHub or Microsoft Entra ID. You can add several identity providers, to allow users to sign in with different accounts. When a person signs in, the identity provider confirms their identitiy and passes on to Speicher.md the following claims:',
        points: [
          'a permanent id of their account',
          'their email address',
          'the groups they are a member of, if the identity provider has groups',
        ],
        preview: 'idp-sign-in',
      },
      {
        title: 'Which identity provider fits?',
        text: 'Choose the provider your readers already have an account with:',
        points: [
          '**GitHub**: GitHub accounts and teams. Since this is the easiest to set up, we recommend it if you are not setting up Speicher.md for an organization.',
          '**Microsoft Entra ID**: the Microsoft accounts and groups of your organization.',
          '**OpenID Connect**: any other provider, such as Google, Keycloak or Okta.',
          '**Magic link (email)**: a sign-in link by email (requires a mail transport).',
        ],
        preview: 'idp-kinds',
      },
    ],
  },
  {
    id: 'groups',
    title: 'How groups work',
    slides: [
      {
        title: 'What is a .speicher.yaml file?',
        text: 'Speicher.md publishes a Git repository once it has a `.speicher.yaml` file at its root. The file configures how the repository is published, for example its title and who may read it.',
        preview: 'speicher-yaml',
      },
      {
        title: 'What is a group?',
        text: 'A group is a named set of people in Speicher.md, identified by its short id, for example `engineering`. A group is used to manage access to repositories. In the `.speicher.yaml` file of a repository, the `access` key lists the groups (by their short id) whose members may read it',
        preview: 'group-add',
      },
      {
        title: 'A group is a list of membership rules',
        text: 'A person is a member as soon as **any** rule of the group matches them. A rule can require that the person:',
        points: [
          'is a member of a group of one of your configured identity providers',
          'signs in with a certain email address',
          'has an email address at a certain domain',
          'is a member of another group of this instance',
        ],
        preview: 'group-members',
      },
      {
        title: 'Members of an identity provider group',
        text: 'An IDP group rule makes everyone a member who is in a certain group of one of your configured identity providers. You choose the provider and enter the id of its group.',
        preview: 'group-provider',
      },
      {
        title: 'Members by email address',
        text: 'An individual email rule makes one person a member. You choose the identity provider the person signs in with and enter their email address.',
        preview: 'group-email',
      },
    ],
  },
  {
    id: 'sources',
    title: 'How content sources work',
    slides: [
      {
        title: 'What is a content source?',
        text: 'A content source is a place Speicher.md reads Git repositories from, for example GitHub or a plain git remote. Speicher.md clones each repository of a source and publishes it once it has a `.speicher.yaml` file at its root. Repositories without this file are skipped.',
        preview: 'source-repositories',
      },
      {
        title: 'Creating the GitHub App',
        text: 'Speicher.md needs a GitHub App to clone your repositories and to be notified about each push. This App is separate from the App of a GitHub identity provider, which signs people in and reads their teams but has no access to repositories. Speicher.md creates the App with its permissions and webhook already filled in, and you only need to confirm the creation of the app on GitHub.',
        preview: 'source-account',
      },
      {
        title: 'Installing the GitHub App',
        text: 'You can install the App on all repositories of the account, or just on selected ones. Speicher.md has read access to all the repositories the App is installed on. For each push to the default branch of a repository, GitHub notifies Speicher.md, which will then synchronize the repository.',
        preview: 'source-install',
      },
    ],
  },
  {
    id: 'repositories',
    title: 'How repositories are published',
    slides: [
      {
        title: 'When is a repository published?',
        text: 'Speicher.md publishes a repository once a content source has access to it and it has a `.speicher.yaml` file at its root. Each Markdown file of the repository becomes a page at `/<owner>/<repository>/…`.',
        preview: 'source-repositories',
      },
      {
        title: 'Who may read a repository?',
        text: 'The `access` key of the `.speicher.yaml` file lists who may read the repository:',
        points: [
          '`groups`: the members of the groups of this instance',
          '`users`: individual people by email address (here you can additionally set an expiration date for each person)',
          'the group `public` under `groups`: everyone, without signing in. It applies once the repository is in the list of public repositories.',
        ],
        preview: 'repository-access',
      },
      {
        title: 'Access in folders',
        text: 'Each folder can have its own `.speicher.yaml` file. Its `access` conditions can only narrow the access of the folder (e.g. the root folder must have the most privileges): a reader needs to be allowed at every level, from the root of the repository down to the folder.',
        preview: 'repository-folders',
      },
      {
        title: 'How a repository is synchronized',
        text: 'Speicher.md synchronizes a repository when it changes, for example with a new commit, and on a regular schedule. The **Sync** column shows the state of each repository.',
        preview: 'repository-sync',
      },
    ],
  },
];

/**
 * walkthroughOf returns the walkthrough of a config page, or undefined when the page has none.
 *
 * @param sectionId the page's config section, e.g. `groups`
 */
export function walkthroughOf(sectionId: string): Walkthrough | undefined {
  return WALKTHROUGHS.find((walkthrough) => walkthrough.id === sectionId);
}

/**
 * walkthroughCookie returns the name of the cookie that says a walkthrough opened by itself once already.
 *
 * @param walkthrough the walkthrough
 */
export function walkthroughCookie(walkthrough: Walkthrough): string {
  return `speicher_walkthrough_${walkthrough.id}`;
}
