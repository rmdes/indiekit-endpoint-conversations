/**
 * Mastodon notification fetcher
 * Direct polling of Mastodon notifications for interaction tracking
 * @module notifications/mastodon
 */

/**
 * Fetch recent Mastodon notifications with pagination
 * @param {object} options - Mastodon connection options
 * @param {string} options.url - Mastodon instance URL
 * @param {string} options.accessToken - Access token
 * @param {string} [options.sinceId] - Only fetch notifications newer than this ID
 * @returns {Promise<Array>} Normalized notification items
 */
export async function fetchMastodonNotifications(options) {
  const { url, accessToken, sinceId } = options;

  if (!url || !accessToken) {
    throw new Error("Mastodon URL and access token required");
  }

  const baseUrl = url.replace(/\/$/, "");
  const allNotifications = [];
  let maxId = null;
  let hasMore = true;

  // Paginate through all notifications since sinceId
  while (hasMore) {
    const params = new URLSearchParams();
    params.append("limit", "40");

    // Mastodon expects types[]=mention&types[]=favourite&types[]=reblog
    for (const type of ["mention", "favourite", "reblog"]) {
      params.append("types[]", type);
    }

    if (sinceId) params.set("since_id", sinceId);
    if (maxId) params.set("max_id", maxId);

    const response = await fetch(
      `${baseUrl}/api/v1/notifications?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const status = response.status;
      const error = new Error(
        `Mastodon API ${status}: ${response.statusText}`,
      );
      error.status = status;
      throw error;
    }

    const page = await response.json();

    if (page.length === 0) {
      hasMore = false;
      break;
    }

    allNotifications.push(...page);

    // If we got fewer than the limit, we've reached the end
    if (page.length < 40) {
      hasMore = false;
    } else {
      // Use the last ID for next page
      maxId = page[page.length - 1].id;
    }

    // Safety limit: max 200 notifications per poll cycle
    if (allNotifications.length >= 200) {
      break;
    }
  }

  return allNotifications.map((notification) =>
    normalizeNotification(notification, baseUrl, accessToken),
  );
}

/**
 * Normalize a Mastodon notification into our internal format
 * Returns the correct lookup URL depending on notification type:
 * - favourite/reblog: notification.status.url (YOUR syndicated post that was interacted with)
 * - mention: notification.status.in_reply_to_id context (which of your posts they replied to)
 */
function normalizeNotification(notification, baseUrl, accessToken) {
  const type = mapNotificationType(notification.type);

  // Determine the correct URL for canonical post lookup
  let lookupUrl = null;

  if (notification.type === "favourite" || notification.type === "reblog") {
    // For favourites/reblogs, notification.status IS the post that was
    // favourited/reblogged — i.e., YOUR syndicated Mastodon post.
    // Its URL maps to your syndication URLs for reverse lookup.
    lookupUrl = notification.status?.url || null;
  } else if (notification.type === "mention") {
    // For mentions, notification.status is the OTHER person's reply.
    // We need notification.status.in_reply_to_id to find which of your
    // posts they replied to. The scheduler will resolve this.
    // We store in_reply_to_id for the scheduler to look up.
    lookupUrl = notification.status?.url || null;
  }

  return {
    platform: "mastodon",
    platform_id: `mastodon:${notification.id}`,
    type,
    author: {
      name: notification.account.display_name || notification.account.username,
      url: notification.account.url,
      photo: notification.account.avatar,
    },
    content: notification.status?.content || null,
    url: notification.status?.url || notification.account.url,
    // The URL to use for finding which of YOUR posts was interacted with
    lookup_url: lookupUrl,
    // For mentions: the ID of the status being replied to (if any)
    in_reply_to_id: notification.status?.in_reply_to_id || null,
    created_at: notification.created_at,
    raw_id: notification.id,
    raw_type: notification.type,
  };
}

function mapNotificationType(type) {
  const map = {
    mention: "reply",
    favourite: "like",
    reblog: "repost",
  };
  return map[type] || "mention";
}
