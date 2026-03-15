/**
 * ActivityPub interaction fetcher
 * Reads inbound interactions from the ap_activities collection
 * (populated by the AP endpoint's inbox listeners) and normalizes
 * them into the conversations plugin's internal format.
 * @module notifications/activitypub
 */

/**
 * Map AP activity types to conversations interaction types
 */
const typeMap = {
  Like: "like",
  Announce: "repost",
  Reply: "reply",
};

/**
 * Fetch ActivityPub interactions since the given cursor
 * @param {object} options
 * @param {object} options.ap_activities - MongoDB collection
 * @param {object} options.ap_followers - MongoDB collection (for avatar lookup)
 * @param {object} [options.nodeinfoCache] - MongoDB collection for NodeInfo cache
 * @param {string} [options.since] - ISO 8601 timestamp cursor (process activities after this)
 * @returns {Promise<{items: Array, cursor: string|null}>}
 */
export async function fetchActivityPubInteractions(options) {
  const { ap_activities, ap_followers, nodeinfoCache, since } = options;

  const query = {
    direction: "inbound",
    type: { $in: ["Like", "Announce", "Reply"] },
  };

  if (since) {
    query.receivedAt = { $gt: since };
  }

  const activities = await ap_activities
    .find(query)
    .sort({ receivedAt: 1 })
    .limit(200)
    .toArray();

  if (activities.length === 0) {
    return { items: [], cursor: null };
  }

  // Resolve server software for all actor domains in this batch
  const { batchResolve } = await import("../nodeinfo/resolver.js");
  const actorUrls = activities.map((a) => a.actorUrl).filter(Boolean);
  const domainSoftware = await batchResolve(actorUrls, nodeinfoCache);

  const items = [];

  for (const activity of activities) {
    // Prefer avatar stored directly on the activity (added by inbox handler),
    // fall back to ap_followers lookup for historical data without actorAvatar
    const avatar =
      activity.actorAvatar ||
      (await lookupAvatar(ap_followers, activity.actorUrl));

    // Resolve platform from NodeInfo (e.g., "mastodon", "pleroma", "misskey")
    const domain = extractDomain(activity.actorUrl);
    const platform = domain ? (domainSoftware.get(domain) || "activitypub") : "activitypub";

    items.push(normalizeActivity(activity, avatar, platform));
  }

  // Cursor is the receivedAt of the last activity processed
  const cursor = activities[activities.length - 1].receivedAt;

  return { items, cursor };
}

/**
 * Extract hostname from a URL
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
 * Normalize an ap_activities document into conversations internal format
 * @param {object} activity - Document from ap_activities
 * @param {string} avatar - Avatar URL from ap_followers lookup
 * @param {string} platform - Resolved server software (e.g., "mastodon", "pleroma")
 * @returns {object} Normalized interaction
 */
function normalizeActivity(activity, avatar, platform) {
  const type = typeMap[activity.type] || "mention";
  const isReply = activity.type === "Reply";

  // For replies: targetUrl is your post, objectUrl is the reply
  // For likes/announces: objectUrl is your post, actorUrl is the source
  const canonicalUrl = isReply
    ? activity.targetUrl || activity.objectUrl
    : activity.objectUrl;

  const url = isReply ? activity.objectUrl : activity.actorUrl;

  return {
    platform,
    platform_id: `activitypub:${activity.type}:${activity.actorUrl}:${activity.objectUrl}`,
    type,
    author: {
      name: activity.actorName || activity.actorUrl,
      url: activity.actorUrl,
      photo: avatar,
    },
    content: activity.content || null,
    url,
    canonical_url: canonicalUrl,
    created_at: activity.receivedAt,
  };
}

/**
 * Look up an actor's avatar from the ap_followers collection
 * @param {object} ap_followers - MongoDB collection
 * @param {string} actorUrl - The actor's URL
 * @returns {Promise<string>} Avatar URL or empty string
 */
async function lookupAvatar(ap_followers, actorUrl) {
  if (!ap_followers || !actorUrl) return "";

  try {
    const follower = await ap_followers.findOne({ actorUrl });
    return follower?.avatar || "";
  } catch {
    return "";
  }
}
