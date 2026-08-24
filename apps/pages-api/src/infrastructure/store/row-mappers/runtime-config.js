import { decryptSiteSecretValue } from '../support/crypto.js';

export async function mapSiteSecret(row, secretEncryptionKey) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    value: await decryptSiteSecretValue(row.encrypted_value, secretEncryptionKey),
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

export function mapSiteSecretMetadata(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

export function mapSiteSecretReadMetadata(row) {
  return {
    name: row.name,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at,
  };
}

export function mapSiteVar(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    value: row.value,
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}
