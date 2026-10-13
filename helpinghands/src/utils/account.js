/**
 * Who is signed in and which workspaces they are in, as the auth gate
 * (theme/Root.js) learned it before it showed any page.
 *
 * The gate asks once and shows nothing until it has the answer, so a page that
 * reads it here never paints for a session it has not seen: there is no
 * "not known yet" for it to draw. `account` is null only on the pages anyone
 * may open (utils/signIn.js), for a visitor who is signed out.
 *
 * `refresh()` asks the server again and returns the answer, for a page that has
 * just changed it, such as accepting an invitation.
 */
import {createContext, useContext} from 'react';

const AccountContext = createContext(null);

export const AccountProvider = AccountContext.Provider;

/** `{account, userId, workspaces, defaultWorkspaceId, offline, refresh}`. */
export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount is read outside the auth gate, which has not answered');
  return value;
}
