import { identityMetadataMethods } from './repositories/identity.js';
import { departmentMetadataMethods } from './transactions/department-metadata.js';

export const pagesMetadataMethods = {
  ...identityMetadataMethods,
  ...departmentMetadataMethods,
};
