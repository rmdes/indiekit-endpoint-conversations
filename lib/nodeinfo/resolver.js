/**
 * NodeInfo-based server software resolver
 * Fetches /.well-known/nodeinfo from a domain, follows the link,
 * and returns the software name (e.g., "mastodon", "pleroma", "misskey").
 * Results are cached in-memory and optionally persisted to MongoDB.
 * @module nodeinfo/resolver
 */

const NODEINFO_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory cache: domain -> { software, resolvedAt }
const memoryCache = new Map();

/**
 * Resolve the server software for a given actor URL via NodeInfo.
 * Returns a lowercase software name like "mastodon", "pleroma", "misskey",
 * "gotosocial", "fedify", etc. Falls back to "activitypub" if NodeInfo
 * is unavailable or unrecognizable.
 *
 * @param {string} actorUrl - The actor's URL (e.g., "https://mastodon.social/@user")
 * @param {object} [collection] - Optional MongoDB collection for persistent cache
 * @returns {Promise<string>} Lowercase software name or "activitypub"
 */
export async function resolveServerSoftware(actorUrl, collection) {
  const domain = extractDomain(actorUrl);
  if (!domain) return "activitypub";

  // Check in-memory cache first
  const cached = memoryCache.get(domain);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.software;
  }

  // Check MongoDB cache
  if (collection) {
    try {
      const doc = await collection.findOne({ _id: domain });
      if (doc && Date.now() - new Date(doc.resolvedAt).getTime() < CACHE_TTL_MS) {
        memoryCache.set(domain, {
          software: doc.software,
          resolvedAt: new Date(doc.resolvedAt).getTime(),
        });
        return doc.software;
      }
    } catch { /* proceed to live fetch */ }
  }

  // Live fetch via NodeInfo protocol
  const software = await fetchNodeInfo(domain);

  // Cache result (even "activitypub" fallback — avoids repeated failed lookups)
  const entry = { software, resolvedAt: Date.now() };
  memoryCache.set(domain, entry);

  if (collection) {
    try {
      await collection.findOneAndUpdate(
        { _id: domain },
        { $set: { software, resolvedAt: new Date().toISOString() } },
        { upsert: true },
      );
    } catch { /* non-critical */ }
  }

  return software;
}

/**
 * Batch-resolve software for multiple actor URLs.
 * Deduplicates by domain so each domain is only queried once.
 *
 * @param {string[]} actorUrls - Array of actor URLs
 * @param {object} [collection] - Optional MongoDB collection for persistent cache
 * @returns {Promise<Map<string, string>>} Map of domain -> software name
 */
export async function batchResolve(actorUrls, collection) {
  const domains = new Set();
  for (const url of actorUrls) {
    const domain = extractDomain(url);
    if (domain) domains.add(domain);
  }

  const results = new Map();
  for (const domain of domains) {
    results.set(
      domain,
      await resolveServerSoftware(`https://${domain}/`, collection),
    );
  }
  return results;
}

/**
 * Extract domain from a URL
 * @param {string} url
 * @returns {string|null}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Fetch NodeInfo for a domain and return the software name
 * @param {string} domain
 * @returns {Promise<string>} Software name or "activitypub"
 */
async function fetchNodeInfo(domain) {
  try {
    // Step 1: Fetch /.well-known/nodeinfo
    const wellKnownUrl = `https://${domain}/.well-known/nodeinfo`;
    const wellKnownResp = await fetch(wellKnownUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(NODEINFO_TIMEOUT_MS),
    });

    if (!wellKnownResp.ok) return "activitypub";

    const wellKnown = await wellKnownResp.json();
    const links = wellKnown.links;
    if (!Array.isArray(links) || links.length === 0) return "activitypub";

    // Prefer NodeInfo 2.x, fall back to any available link
    const link =
      links.find((l) => l.rel?.includes("nodeinfo/2.")) ||
      links[0];

    if (!link?.href) return "activitypub";

    // Step 2: Fetch the actual NodeInfo document
    const nodeInfoResp = await fetch(link.href, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(NODEINFO_TIMEOUT_MS),
    });

    if (!nodeInfoResp.ok) return "activitypub";

    const nodeInfo = await nodeInfoResp.json();
    const softwareName = nodeInfo.software?.name;

    if (typeof softwareName === "string" && softwareName.trim()) {
      return softwareName.trim().toLowerCase();
    }

    return "activitypub";
  } catch {
    return "activitypub";
  }
}
