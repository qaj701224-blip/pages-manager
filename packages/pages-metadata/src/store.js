import { metadataFoundationMethods } from './repositories/foundation.js';
import { pagesMetadataMethods } from './methods.js';

const metadataStoreMethods = {
  ...metadataFoundationMethods,
  ...pagesMetadataMethods,
};

export function createPagesMetadataStore(db, options = {}) {
  if (!db) throw new Error('Pages metadata database is required');
  return new PagesMetadataStore(db, options);
}

class PagesMetadataStore {
  constructor(db, { now = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.now = now;
  }
}

for (const [name, method] of Object.entries(metadataStoreMethods)) {
  Object.defineProperty(PagesMetadataStore.prototype, name, {
    configurable: true,
    enumerable: false,
    value: method,
    writable: true,
  });
}
