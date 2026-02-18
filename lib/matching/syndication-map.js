/**
 * Syndication URL reverse lookup
 * Maps syndication URLs back to canonical post URLs
 * @module matching/syndication-map
 */

/**
 * Find the canonical post URL for a syndication URL
 * Queries the posts collection for posts with matching syndication entries
 * @param {object} application - Indiekit application
 * @param {string} syndicationUrl - The syndication URL to look up
 * @returns {Promise<string|null>} Canonical post URL or null
 */
export async function findCanonicalPost(application, syndicationUrl) {
  const posts = application.collections.get("posts");
  if (!posts) return null;

  const post = await posts.findOne({
    "properties.syndication": syndicationUrl,
  });

  return post?.properties?.url || null;
}

/**
 * Find the canonical post URL by matching against multiple possible target URLs
 * Used when a webmention target could be either the canonical URL or a syndication URL
 * @param {object} application - Indiekit application
 * @param {string} targetUrl - The webmention target URL
 * @param {string} siteUrl - The site's base URL
 * @returns {Promise<string>} Canonical post URL (may be the target itself)
 */
export async function resolveCanonicalUrl(application, targetUrl, siteUrl) {
  // If the target is already on our domain, it's likely canonical
  if (targetUrl.startsWith(siteUrl)) {
    return targetUrl;
  }

  // Otherwise try to find via syndication reverse lookup
  const canonical = await findCanonicalPost(application, targetUrl);
  return canonical || targetUrl;
}
