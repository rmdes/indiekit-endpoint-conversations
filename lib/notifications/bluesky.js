/**
 * Bluesky notification fetcher
 * Direct polling of Bluesky notifications with session caching
 * @module notifications/bluesky
 */

// Cached session (module-level, survives across poll cycles)
let cachedSession = null;
let sessionExpiresAt = 0;

/**
 * Fetch recent Bluesky notifications
 * @param {object} options - Bluesky connection options
 * @param {string} options.identifier - Bluesky handle or DID
 * @param {string} options.password - App password
 * @param {string} [options.serviceUrl] - PDS service URL
 * @param {string} [options.cursor] - Pagination cursor from previous fetch
 * @returns {Promise<object>} { items: Array, cursor: string }
 */
export async function fetchBlueskyNotifications(options) {
  const { identifier, password, serviceUrl = "https://bsky.social" } = options;

  if (!identifier || !password) {
    throw new Error("Bluesky identifier and password required");
  }

  // Get or refresh session
  const session = await getSession(serviceUrl, identifier, password);

  // Fetch notifications
  const params = new URLSearchParams({ limit: "50" });
  if (options.cursor) params.set("cursor", options.cursor);

  let notifResponse = await fetch(
    `${serviceUrl}/xrpc/app.bsky.notification.listNotifications?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${session.accessJwt}` },
    },
  );

  // On 401, force re-auth and retry once
  if (notifResponse.status === 401) {
    cachedSession = null;
    const freshSession = await getSession(serviceUrl, identifier, password);
    notifResponse = await fetch(
      `${serviceUrl}/xrpc/app.bsky.notification.listNotifications?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${freshSession.accessJwt}` },
      },
    );
  }

  if (!notifResponse.ok) {
    const error = new Error(
      `Bluesky notifications failed: ${notifResponse.status}`,
    );
    error.status = notifResponse.status;
    throw error;
  }

  const data = await notifResponse.json();
  const relevantReasons = new Set(["reply", "like", "repost", "mention"]);

  const items = data.notifications
    .filter((n) => relevantReasons.has(n.reason))
    .map((notification) => normalizeNotification(notification));

  return {
    items,
    cursor: data.cursor,
  };
}

/**
 * Get a valid session, using cache or refreshing as needed
 */
async function getSession(serviceUrl, identifier, password) {
  const now = Date.now();

  // Try to refresh if we have a cached session nearing expiry (< 2 min left)
  if (cachedSession && now < sessionExpiresAt - 120_000) {
    return cachedSession;
  }

  // Try refresh if we have a refresh token
  if (cachedSession?.refreshJwt) {
    try {
      const refreshResponse = await fetch(
        `${serviceUrl}/xrpc/com.atproto.server.refreshSession`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cachedSession.refreshJwt}`,
          },
        },
      );

      if (refreshResponse.ok) {
        cachedSession = await refreshResponse.json();
        // AT Protocol access tokens typically last ~2 hours
        sessionExpiresAt = now + 90 * 60 * 1000;
        return cachedSession;
      }
    } catch {
      // Refresh failed, fall through to fresh auth
    }
  }

  // Create fresh session
  const sessionResponse = await fetch(
    `${serviceUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    },
  );

  if (!sessionResponse.ok) {
    const error = new Error(
      `Bluesky auth failed: ${sessionResponse.status}`,
    );
    error.status = sessionResponse.status;
    throw error;
  }

  cachedSession = await sessionResponse.json();
  sessionExpiresAt = now + 90 * 60 * 1000;
  return cachedSession;
}

/**
 * Normalize a Bluesky notification
 * Returns the correct lookup URI depending on notification type:
 * - like/repost: notification.record.subject.uri (AT URI of YOUR post)
 * - reply: notification.record.reply.parent.uri (AT URI of YOUR post being replied to)
 * - mention: notification's own URI (the mentioning post)
 */
function normalizeNotification(notification) {
  const type = mapNotificationReason(notification.reason);

  // Determine the AT URI of YOUR post that was interacted with
  let subjectUri = null;

  if (notification.reason === "like" || notification.reason === "repost") {
    // record.subject.uri is the AT URI of the post that was liked/reposted
    subjectUri = notification.record?.subject?.uri || null;
  } else if (notification.reason === "reply") {
    // record.reply.parent.uri is the AT URI of the post being replied to
    subjectUri = notification.record?.reply?.parent?.uri || null;
  }

  // Convert the subject URI to a web URL for syndication lookup
  const subjectWebUrl = subjectUri
    ? uriToPostUrl(subjectUri)
    : null;

  // The notification author's post URL (for display/linking)
  const authorPostUrl = uriToPostUrl(
    notification.uri,
    notification.author.handle,
  );

  return {
    platform: "bluesky",
    platform_id: `bluesky:${notification.uri}`,
    type,
    author: {
      name: notification.author.displayName || notification.author.handle,
      url: `https://bsky.app/profile/${notification.author.handle}`,
      photo: notification.author.avatar || null,
    },
    content: notification.record?.text || null,
    // URL of the interaction itself (for display)
    url: authorPostUrl,
    // URL of YOUR post for canonical lookup
    lookup_url: subjectWebUrl,
    // Raw AT URI of your post (for additional lookups)
    subject_uri: subjectUri,
    created_at: notification.indexedAt,
    raw_uri: notification.uri,
    raw_reason: notification.reason,
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
 * @param {string} uri - AT Protocol URI (at://did/app.bsky.feed.post/rkey)
 * @param {string} [handleHint] - Handle to use if DID can't be resolved
 * @returns {string|null} Web URL or null
 */
export function uriToPostUrl(uri, handleHint) {
  if (!uri) return null;
  const match = uri.match(/at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)/);
  if (match) {
    const [, didOrHandle, rkey] = match;
    // If it looks like a handle already, use it; otherwise use hint or DID
    const profile =
      didOrHandle.startsWith("did:") ? (handleHint || didOrHandle) : didOrHandle;
    return `https://bsky.app/profile/${profile}/post/${rkey}`;
  }
  return null;
}
