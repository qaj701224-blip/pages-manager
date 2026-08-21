export function hostnameForSiteSlug(slug, config) {
  if (config.environment === 'staging') return `${slug}-staging.${config.siteDomainSuffix}`;
  return `${slug}.${config.siteDomainSuffix}`;
}
