/**
 * Webmention classifier
 * Classifies incoming webmentions by source protocol
 * @module ingestion/webmention-classifier
 */

/**
 * Classify a webmention source URL by protocol origin
 * @param {object} webmention - Webmention data
 * @param {string} webmention.source - Source URL of the webmention
 * @param {object} [webmention.author] - Author data if available
 * @returns {object} Classification result
 */
export function classifyWebmention(webmention) {
  const source = webmention.source || "";
  const authorUrl = webmention.author?.url || "";

  // Bridgy pattern: https://brid.gy/{action}/{platform}/...
  const bridgyMatch = source.match(
    /brid\.gy\/(comment|like|repost|mention)\/(mastodon|bluesky|twitter|flickr|github)\//i,
  );

  if (bridgyMatch) {
    const [, action, platform] = bridgyMatch;
    return {
      source: mapBridgyPlatform(platform),
      type: mapBridgyAction(action),
      bridgy_url: source,
      confidence: "high",
    };
  }

  // Bridgy Fed pattern: https://fed.brid.gy/...
  if (source.includes("fed.brid.gy")) {
    return {
      source: "mastodon",
      type: inferTypeFromUrl(source),
      bridgy_url: source,
      confidence: "high",
    };
  }

  // Direct URL pattern matching (non-Bridgy webmentions)
  if (authorUrl.includes("bsky.app") || source.includes("bsky.app")) {
    return {
      source: "bluesky",
      type: inferTypeFromUrl(source),
      bridgy_url: null,
      confidence: "medium",
    };
  }

  if (isFediverseUrl(authorUrl) || isFediverseUrl(source)) {
    return {
      source: "mastodon",
      type: inferTypeFromUrl(source),
      bridgy_url: null,
      confidence: "medium",
    };
  }

  // Default: direct webmention from the open web
  return {
    source: "webmention",
    type: webmention["wm-property"]
      ? mapWmProperty(webmention["wm-property"])
      : inferTypeFromUrl(source),
    bridgy_url: null,
    confidence: "low",
  };
}

/**
 * Map Bridgy platform names to our source types
 */
function mapBridgyPlatform(platform) {
  const map = {
    mastodon: "mastodon",
    bluesky: "bluesky",
    twitter: "twitter",
    flickr: "flickr",
    github: "github",
  };
  return map[platform.toLowerCase()] || "webmention";
}

/**
 * Map Bridgy action types to interaction types
 */
function mapBridgyAction(action) {
  const map = {
    comment: "reply",
    like: "like",
    repost: "repost",
    mention: "mention",
  };
  return map[action.toLowerCase()] || "mention";
}

/**
 * Map webmention.io wm-property to interaction type
 */
function mapWmProperty(property) {
  const map = {
    "in-reply-to": "reply",
    "like-of": "like",
    "repost-of": "repost",
    "bookmark-of": "bookmark",
    "mention-of": "mention",
  };
  return map[property] || "mention";
}

/**
 * Infer interaction type from URL patterns
 */
function inferTypeFromUrl(url) {
  if (!url) return "mention";
  if (url.includes("/reply") || url.includes("/comment")) return "reply";
  if (url.includes("/like") || url.includes("/favourite")) return "like";
  if (url.includes("/repost") || url.includes("/reblog")) return "repost";
  return "mention";
}

/**
 * Check if URL belongs to a known Fediverse instance
 */
function isFediverseUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("mastodon.") ||
    lower.includes("mstdn.") ||
    lower.includes("fosstodon.") ||
    lower.includes("pleroma.") ||
    lower.includes("misskey.") ||
    lower.includes("pixelfed.")
  );
}

/**
 * Generate a platform-specific dedup key
 * @param {object} webmention - Classified webmention data
 * @returns {string} Dedup key like "mastodon:123456" or "webmention:https://..."
 */
export function generatePlatformId(webmention) {
  const source = webmention.source || "";

  // Extract Mastodon status ID from URL
  const mastodonMatch = source.match(
    /\/@[^/]+\/(\d+)/,
  );
  if (mastodonMatch) {
    return `mastodon:${mastodonMatch[1]}`;
  }

  // Extract Bluesky rkey from URL
  const bskyMatch = source.match(
    /bsky\.app\/profile\/[^/]+\/post\/([a-z0-9]+)/i,
  );
  if (bskyMatch) {
    return `bluesky:${bskyMatch[1]}`;
  }

  // Fallback: hash the source URL
  return `webmention:${source}`;
}
