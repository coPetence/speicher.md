import { CallerIdentity } from '../authz/caller';

export interface CompletedLogin {
  identity: CallerIdentity;

  /** Group ids from the id token (if provider includes them) */
  rawGroupIds: string[];

  /** location of the sign-in request start  */
  redirectTo: string;

  /** true if sign-in happens during setup phase (promotion to first admin) */
  namesFirstAdmin: boolean;
}
