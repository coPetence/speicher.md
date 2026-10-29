import { CodedError } from '../common/errors';

/** OIDC and GitHub sign-in error codes */
export type SignInCode =
  | 'signin.unknown-state'
  | 'signin.flow-expired'
  | 'signin.token-exchange-failed'
  | 'signin.token-exchange-refused'
  | 'signin.token-missing'
  | 'signin.nonce-mismatch'
  | 'signin.subject-missing'
  | 'signin.wrong-provider'
  | 'signin.discovery-failed'
  | 'signin.api-failed'
  | 'signin.installation-unseen';

/** Sign-in error with the provider's HTTP status, if available */
export class SignInError extends CodedError<SignInCode> {
  constructor(
    code: SignInCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(code, message);
  }
}
