import { validateSiteSlug } from '@xd/pages-runtime-protocol';

const METADATA_FIELDS = new Set(['title', 'slug']);

export function normalizeSiteMetadataPatch(value, { environment } = {}) {
  if (!isPlainObject(value)) throw metadataError('SITE_METADATA_INVALID');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !METADATA_FIELDS.has(key))) {
    throw metadataError('SITE_METADATA_INVALID');
  }

  const patch = {};
  if (Object.hasOwn(value, 'title')) patch.title = normalizeSiteTitle(value.title);
  if (Object.hasOwn(value, 'slug')) patch.slug = normalizeMetadataSlug(value.slug, environment);
  return patch;
}

export function siteMetadataRoutingStatus(site) {
  return site?.slugRoutingSyncedRevision === site?.slugRevision ? 'ready' : 'pending';
}

function normalizeSiteTitle(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw metadataError('SITE_TITLE_INVALID');
  const normalized = value.normalize('NFC');
  if (containsInvalidTitleCharacter(normalized)) throw metadataError('SITE_TITLE_INVALID');
  const title = normalized.trim();
  const length = [...title].length;
  if (length < 1 || length > 80) {
    throw metadataError('SITE_TITLE_INVALID');
  }
  return title;
}

function containsInvalidTitleCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029) {
      return true;
    }
  }
  return false;
}

function normalizeMetadataSlug(value, environment) {
  if (typeof value !== 'string') throw metadataError('SITE_SLUG_INVALID');
  const slug = value.trim().toLowerCase();
  const validation = validateSiteSlug(slug, { environment });
  if (!validation.ok) {
    throw metadataError(validation.error.code === 'RESERVED_SLUG' ? 'SITE_SLUG_RESERVED' : 'SITE_SLUG_INVALID');
  }
  return slug;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function metadataError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
