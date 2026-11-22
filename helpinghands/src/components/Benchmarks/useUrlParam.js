import {useHistory, useLocation} from '@docusaurus/router';

/** `[value, set]` of the URL's `?name=` (null when absent). `set` pushes a history entry, so the browser's back goes to the screen before. */
export default function useUrlParam(name) {
  const location = useLocation();
  const history = useHistory();
  const set = next => {
    const params = new URLSearchParams(location.search);
    if (next === null) params.delete(name);
    else params.set(name, next);
    const search = params.toString();
    history.push(`${location.pathname}${search ? `?${search}` : ''}`);
  };
  return [new URLSearchParams(location.search).get(name), set];
}
