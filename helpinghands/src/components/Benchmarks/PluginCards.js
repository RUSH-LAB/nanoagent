import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import useWorkspaceApps from '@site/src/hooks/useWorkspaceApps';

/** The member's installed plugins that are ready to run: `{apps, error}`, `apps` null until they arrive. */
export function useBenchmarkPlugins() {
  const {workspace} = useWorkspaceSite();
  const {apps, error} = useWorkspaceApps(workspace);
  return {apps: apps && apps.filter(app => app.status === 'ready'), error};
}
