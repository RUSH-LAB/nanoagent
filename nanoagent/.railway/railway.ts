import {defineRailway, project, service} from 'railway/iac';

// This repository owns only the private NanoAgent service. RUSH's repository
// owns the public application service in the same Railway project.
export const partial = 'nanoagent';

export default defineRailway(() => {
  const nanoagent = service('nanoagent', {
    healthcheck: '/health',
    healthcheckTimeout: 120,
  });

  return project('nanoagent', {
    resources: [nanoagent],
  });
});
