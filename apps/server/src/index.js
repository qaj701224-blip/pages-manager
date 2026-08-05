import { legacyApiRetirementResponseForRequest } from './retirement.js';

export default {
  async fetch(request) {
    return legacyApiRetirementResponseForRequest(request);
  },
};
