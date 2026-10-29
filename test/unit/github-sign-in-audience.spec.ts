import {
  SIGN_IN_AUDIENCES,
  signInAudienceText,
} from '../../src/dashboard/configurator/github-sign-in-audience';

describe('who can sign in with a GitHub App', () => {
  const app = (owner_is_organization: boolean, isPublic?: boolean) => ({
    owner_account: owner_is_organization ? 'acme' : 'ferdi',
    owner_is_organization,
    public: isPublic,
  });

  it('says it for each of the four answers the add modal offers', () => {
    expect(
      SIGN_IN_AUDIENCES.map((audience) =>
        signInAudienceText(app(audience.organization, audience.public)),
      ),
    ).toEqual([
      'Only members of acme can sign in',
      'Members of acme and anyone else with a GitHub account can sign in',
      'Anyone with a GitHub account can sign in',
      'Only ferdi can sign in',
    ]);
  });

  it('marks up the account it names', () => {
    expect(signInAudienceText(app(true, false), (account) => `**${account}**`)).toBe(
      'Only members of **acme** can sign in',
    );
  });

  it('says nothing of an App whose visibility it was not told', () => {
    expect(signInAudienceText(app(true))).toBeNull();
  });
});
