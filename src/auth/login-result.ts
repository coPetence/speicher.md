import { CallerIdentity } from '../authz/caller';

/**
 * What a completed sign-in yields, whoever verified it.
 *
 * One shape for both the OIDC and the GitHub flow, so `AuthController` finishes a
 * sign-in in one place rather than once per provider: first-admin promotion, the
 * session row and the setup latch are what *being signed in* means here, and a
 * provider that reached them by its own route would eventually mean something
 * slightly different by it.
 */
export interface CompletedLogin {
  identity: CallerIdentity;

  /** Group ids exactly as the provider named them, resolved to internal groups later */
  rawGroupIds: string[];

  /** Where the sign-in was started from, already passed through `safeRedirect` */
  redirectTo: string;

  /** Whether this sign-in is the one that may name the first administrator */
  namesFirstAdmin: boolean;
}
