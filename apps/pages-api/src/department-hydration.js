import { fetchOrgUsersByEmail } from '@xd/org-directory';
import { hydrateUserDepartment, shouldHydrateUserDepartment } from '@xd/pages-metadata';

import { readOrgDirectoryConfig } from './infrastructure/config/org-directory-config.js';

export { shouldHydrateUserDepartment };

export async function hydrateUserDepartmentFromDirectory({ env, store, environment, user }) {
  const config = readOrgDirectoryConfig(env);
  const directory = config
    ? {
        findUsersByEmail: (emails) =>
          fetchOrgUsersByEmail({
            emails,
            token: config.token,
            fetchImpl: config.fetchImpl,
          }),
      }
    : null;
  return hydrateUserDepartment({
    store,
    environment,
    user,
    directory,
    clock: env,
  });
}
