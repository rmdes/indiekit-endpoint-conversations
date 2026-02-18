/**
 * Bluesky notification fetcher
 * Optional direct polling of Bluesky notifications
 * @module notifications/bluesky
 */

/**
 * Fetch recent Bluesky notifications
 * @param {object} options - Bluesky connection options
 * @param {string} options.identifier - Bluesky handle or DID
 * @param {string} options.password - App password
 * @param {string} options.serviceUrl - PDS service URL
 * @param {string} [options.cursor] - Pagination cursor from previous fetch
 * @returns {Promise<object>} { items: Array, cursor: string }
 */
export async function fetchBlueskyNotifications(options) {
  const { identifier, password, serviceUrl = "https://bsky.social" } = options;

  if (!identifier || !password) {
    throw new Error("Bluesky identifier and password required");
  }

  // Create session
  const sessionResponse = await fetch(
    `${serviceUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    },
  );

  if (!sessionResponse.ok) {
    throw new Error(
      `Bluesky auth failed: ${sessionResponse.status}`,
    );
  }

  const session = await sessionResponse.json();

  // Fetch notifications
  const params = new URLSearchParams({ limit: "50" });
  if (options.cursor) params.set("cursor", options.cursor);

  const notifResponse = await fetch(
    `${serviceUrl}/xrpc/app.bsky.notification.listNotifications?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${session.accessJwt}` },
    },
  );

  if (!notifResponse.ok) {
    throw new Error(
      `Bluesky notifications failed: ${notifResponse.status}`,
    );
  }

  const data = await notifResponse.json();
  const relevantReasons = new Set(["reply", "like", "repost", "mention"]);

  const items = data.notifications
    .filter((n) => relevantReasons.has(n.reason))
    .map((notification) => ({
      platform: "bluesky",
      platform_id: `bluesky:${notification.uri}`,
      type: mapNotificationReason(notification.reason),
      author: {
        name:
          notification.author.displayName || notification.author.handle,
        url: `https://bsky.app/profile/${notification.author.handle}`,
        photo: notification.author.avatar,
      },
      content: notification.record?.text || null,
      url: uriToUrl(notification.uri, notification.author.handle),
      created_at: notification.indexedAt,
      raw_uri: notification.uri,
    }));

  return {
    items,
    cursor: data.cursor,
  };
}

function mapNotificationReason(reason) {
  const map = {
    reply: "reply",
    like: "like",
    repost: "repost",
    mention: "mention",
  };
  return map[reason] || "mention";
}

/**
 * Convert AT URI to Bluesky web URL
 */
function uriToUrl(uri, handle) {
  if (!uri) return null;
  const match = uri.match(/at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)/);
  if (match) {
    return `https://bsky.app/profile/${handle}/post/${match[2]}`;
  }
  return null;
}
