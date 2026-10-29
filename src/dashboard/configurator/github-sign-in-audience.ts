/**
 * Who can sign in with a GitHub provider, as its App decides it
 *
 * GitHub lets only the members of the account an App belongs to sign in with a
 * private App, and anybody with a public one. So the four answers to who should
 * be able to sign in are an owner and a visibility, and GitHub enforces them
 */

export interface SignInAudience {
  value: string;
  label: string;
  // Whether the App belongs to an organization, which the modal then asks for
  organization: boolean;
  public: boolean;
}

// Narrowest first
export const SIGN_IN_AUDIENCES: SignInAudience[] = [
  { value: 'org', label: 'Members of my organization', organization: true, public: false },
  {
    value: 'org-and-others',
    label: 'Members of my organization and other GitHub users',
    organization: true,
    public: true,
  },
  { value: 'anyone', label: 'Anyone with a GitHub account', organization: false, public: true },
  { value: 'me', label: 'Only me', organization: false, public: false },
];

/**
 * signInAudienceText returns who can sign in with a provider's App, as a line without a full stop, or null when
 * Speicher.md did not create the App.
 *
 * @param app the App as the provider stores it
 * @param markup wraps the account name, e.g. in bold
 */
export function signInAudienceText(
  app: { owner_account?: unknown; owner_is_organization?: unknown; public?: unknown },
  markup: (account: string) => string = (account) => account,
): string | null {
  if (typeof app.public !== 'boolean' || typeof app.owner_account !== 'string') return null;
  const account = markup(app.owner_account);
  if (app.owner_is_organization === true) {
    return app.public
      ? `Members of ${account} and anyone else with a GitHub account can sign in`
      : `Only members of ${account} can sign in`;
  }
  return app.public ? 'Anyone with a GitHub account can sign in' : `Only ${account} can sign in`;
}
