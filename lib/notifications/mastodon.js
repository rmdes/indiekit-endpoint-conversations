/**
 * Mastodon notification fetcher
 * Optional direct polling of Mastodon notifications
 * @module notifications/mastodon
 */

/**
 * Fetch recent Mastodon notifications
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

  const params = new URLSearchParams({
    limit: "40",
    types: ["mention", "favourite", "reblog"].join(","),
  });
  if (sinceId) params.set("since_id", sinceId);

  const response = await fetch(
    `${url}/api/v1/notifications?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Mastodon API ${response.status}: ${response.statusText}`);
  }

  const notifications = await response.json();

  return notifications.map((notification) => ({
    platform: "mastodon",
    platform_id: `mastodon:${notification.id}`,
    type: mapNotificationType(notification.type),
    author: {
      name: notification.account.display_name || notification.account.username,
      url: notification.account.url,
      photo: notification.account.avatar,
    },
    content: notification.status?.content || null,
    url: notification.status?.url || notification.account.url,
    status_url: notification.status?.url,
    created_at: notification.created_at,
    raw_id: notification.id,
  }));
}

function mapNotificationType(type) {
  const map = {
    mention: "reply",
    favourite: "like",
    reblog: "repost",
  };
  return map[type] || "mention";
}
