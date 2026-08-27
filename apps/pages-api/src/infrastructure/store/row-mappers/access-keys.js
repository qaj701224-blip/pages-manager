export function mapAccessKey(row) {
  return {
    id: row.id,
    environment: row.environment || null,
    ownerType: row.owner_type ?? 'user',
    ownerId: row.owner_id ?? row.owner_user_id,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id || row.owner_user_id,
    issuedSource: row.issued_source || 'legacy',
    issuedSessionVersion: row.issued_session_version ?? null,
    keyHash: row.key_hash,
    pepperId: row.pepper_id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json),
    siteId: row.site_id,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id || null,
    revokedReason: row.revoked_reason || null,
    createdAt: row.created_at,
  };
}
