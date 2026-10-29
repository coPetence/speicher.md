import { primaryOf } from '../../src/dashboard/configurator/quick-setup/ready';
import { SetupState, setupSteps } from '../../src/dashboard/setup/steps';

describe('the main button of the modal a quick setup ends on', () => {
  const during = (state: { providers: number; source: boolean; administrator: boolean }) => {
    const setup: SetupState = {
      providerShortIds: Array.from({ length: state.providers }, (_, index) => `p${index}`),
      hasAdministrator: state.administrator,
      hasContentSource: state.source,
      hasMagicLinkProvider: false,
      hasMailTransport: false,
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

  it('leads on to the content source once the first setup has its provider', () => {
    expect(
      primaryOf(during({ providers: 1, source: false, administrator: false }), 'identity'),
    ).toEqual({
      label: 'Continue',
      // The add modal, open on the GitHub quick setup
      href: '/-/config/sources?kind=github',
      onward: true,
    });
  });

  it('leads on to the first administrator once the source is there too', () => {
    expect(
      primaryOf(during({ providers: 1, source: true, administrator: false }), 'sources'),
    ).toEqual({
      label: 'Continue',
      href: '/-/setup/administrator',
      onward: true,
    });
  });
});
