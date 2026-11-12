export type WalkthroughPreview =
  | 'idp-sign-in'
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
  | 'repository-folders';

export interface WalkthroughSlide {
  title: string;
  // Markdown
  text?: string;
  // A list under the text, each point in markdown
  points?: string[];
  options?: WalkthroughOption[];
  faq?: WalkthroughQuestion[];
  preview?: WalkthroughPreview;
}

export interface WalkthroughOption {
  mark: 'github' | 'microsoft' | 'openid' | 'mail';
  name: string;
  text: string;
  recommended?: boolean;
}

export interface WalkthroughQuestion {
  question: string;
  answer: string;
  points?: string[];
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
        title: '',
        faq: [
          {
            question: 'What is an identity provider?',
            answer:
              'An identity provider is a service from a third party that authenticates a user, for example GitHub or Microsoft Entra ID.',
          },
          {
            question: 'Can I add more than one identity provider?',
            answer:
              'Yes, you could for example add an Identity provider of an external organization you want to share documents with, in addition to your own Identity Provider.',
          },
          {
            question: 'What does speicher.md learn about a person?',
            answer:
              'When a person signs in, the identity provider passes on the following claims to speicher.md:',
            points: [
              'a permanent id of their account',
              'their email address',
              'the groups they are a member of, if the identity provider has groups',
            ],
          },
        ],
        preview: 'idp-sign-in',
      },
      {
        title: 'Which identity provider fits?',
        text: 'Choose the provider your readers already have an account with:',
        options: [
          {
            mark: 'github',
            name: 'GitHub',
            text: 'GitHub accounts and teams. This is the easiest provider to set up.',
            recommended: true,
          },
          {
            mark: 'microsoft',
            name: 'Microsoft Entra ID',
            text: 'The Microsoft accounts and groups of your organization.',
          },
          {
            mark: 'openid',
            name: 'OpenID Connect',
            text: 'Any other provider, such as Google, Keycloak or Okta.',
          },
          {
            mark: 'mail',
            name: 'Magic link (email)',
            text: 'A sign-in link by email. This requires a mail transport.',
          },
        ],
      },
    ],
  },
  {
    id: 'groups',
    title: 'How groups work',
    slides: [
      {
        title: 'What is a .speicher.yaml file?',
        text: 'speicher.md publishes a Git repository once it has a `.speicher.yaml` file at its root. The file configures how the repository is published, for example its title and who may read it.',
        preview: 'speicher-yaml',
      },
      {
        title: 'What is a group?',
        text: 'A group is a named set of people in speicher.md, identified by its short id, for example `engineering`. A group is used to manage access to repositories. In the `.speicher.yaml` file of a repository, you can add the groups (by their short id) under the `access` key to specify who can read the pages of this repository.',
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
        text: 'A content source is a location (like GitHub or a plain git remote) where speicher.md looks for your repositories. speicher.md scans the source and clones all available repositories. If a repository has a .speicher.yaml file at its root, it gets published; otherwise, it is ignored.',
        preview: 'source-repositories',
      },
      {
        title: 'Creating the GitHub App',
        faq: [
          {
            question: 'What does the GitHub App do?',
            answer:
              'The GitHub App gives speicher.md read access to the contents of your repositories. When you push new content to a repository, GitHub will notify speicher.md through the webhook of the App and speicher.md will synchronize the repository again.',
          },
          {
            question: 'I already created a GitHub App. Why do I need another one?',
            answer:
              'You have likely already created a GitHub App to authenticate users, e.g. in the configuration of your identity provider, however this App does not have any access to your repositories. The App you need to create here is a second App that gives speicher.md read access to your repositories. While both functions can theoretically run within a single application, separating them is recommended to isolate their keys and secrets.',
          },
        ],
        preview: 'source-account',
      },
      {
        title: 'Installing the GitHub App',
        faq: [
          {
            question: 'Which repositories can I install the App on?',
            answer:
              'You can install the App on all repositories of your account, or only on the ones you select.',
          },
          {
            question: 'What can speicher.md access?',
            answer: 'speicher.md has read access to all the repositories the App is installed on.',
          },
          {
            question: 'When does speicher.md synchronize a repository?',
            answer:
              'For each push to the default branch of a repository, GitHub notifies speicher.md, which then synchronizes the repository.',
          },
        ],
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
        text: 'speicher.md publishes a repository once a content source has access to it and it has a `.speicher.yaml` file at its root. Each Markdown file of the repository becomes a page at `/<owner>/<repository>/…`.',
        preview: 'source-repositories',
      },
      {
        title: 'Who may read a repository?',
        text: 'The `access` key of the `.speicher.yaml` file lists who may read the repository:',
        points: [
          '`groups`: the members of the groups of this instance',
          '`users`: individual people by email address (here you can additionally set an expiration date for each person)',
          'the group `public` under `groups`: everyone, without signing in. This only applies once the repository is in the list of public repositories. You can add a repository to the list of public repositories [here](/-/config/public).',
        ],
        preview: 'repository-access',
      },
      {
        title: 'Access in folders',
        text: 'Each folder can have its own `.speicher.yaml` file. Its `access` conditions can only narrow the access of the folder (e.g. the root folder must have the most privileges): a reader needs to be allowed at every level, from the root of the repository down to the folder.',
        preview: 'repository-folders',
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
