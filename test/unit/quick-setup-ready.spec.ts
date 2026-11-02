import { primaryOf } from '../../src/dashboard/configurator/quick-setup/ready';
import { SetupState, setupSteps } from '../../src/dashboard/setup/steps';

describe('the main button of the modal a quick setup ends on', () => {
  const during = (state: {
    providers: number;
    administrator: boolean;
    groups: number;
    source: boolean;
  }) => {
    const setup: SetupState = {
      providerShortIds: Array.from({ length: state.providers }, (_, index) => `p${index}`),
      hasAdministrator: state.administrator,
      hasContentSource: state.source,
      hasMagicLinkProvider: false,
      hasMailTransport: false,
      groupNames: Array.from({ length: state.groups }, (_, index) => `g${index}`),
      // Each group with a member, which is what makes it count
      groupItems: () => [{ group: 'other' }],
    };
    return setupSteps(setup);
  };

  it('closes onto the list outside the first setup', () => {
    expect(primaryOf([], 'identity')).toEqual({
      label: 'Done',
      href: '/-/config/identity',
      onward: false,
    });
  });

  it('leads on to the first administrator once the first setup has its provider', () => {
    expect(
      primaryOf(
        during({ providers: 1, administrator: false, groups: 0, source: false }),
        'identity',
      ),
    ).toEqual({ label: 'Continue', href: '/-/setup/administrator', onward: true });
  });

  it('leads on to the groups once the administrator is there', () => {
    expect(
      primaryOf(
        during({ providers: 1, administrator: true, groups: 0, source: false }),
        'identity',
      ),
    ).toEqual({ label: 'Continue', href: '/-/config/groups', onward: true });
  });

  it('leads on to the content sources page, where its walkthrough opens first, once a group exists', () => {
    expect(
      primaryOf(during({ providers: 1, administrator: true, groups: 1, source: false }), 'groups'),
    ).toEqual({ label: 'Continue', href: '/-/config/sources', onward: true });
  });

  it('leads on to the repository once the source is there too', () => {
    expect(
      primaryOf(during({ providers: 1, administrator: true, groups: 1, source: true }), 'sources'),
    ).toEqual({ label: 'Continue', href: '/-/repositories', onward: true });
  });
});
