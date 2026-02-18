/**
 * Background polling scheduler
 * Only active when direct polling is enabled via config
 * @module polling/scheduler
 */

import { findCanonicalPost } from "../matching/syndication-map.js";
import { upsertConversationItem } from "../storage/conversation-items.js";

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
let pollTimer = null;

/**
 * Start the background polling loop
 * @param {object} application - Indiekit application
 * @param {object} options - Plugin options
 */
export function startPolling(application, options) {
  console.info("[Conversations] Starting direct polling scheduler");

  // Run immediately, then on interval
  runPollCycle(application, options).catch((error) => {
    console.error("[Conversations] Initial poll cycle error:", error.message);
  });

  pollTimer = setInterval(() => {
    runPollCycle(application, options).catch((error) => {
      console.error("[Conversations] Poll cycle error:", error.message);
    });
  }, POLL_INTERVAL);
}

/**
 * Stop the polling scheduler
 */
export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.info("[Conversations] Polling scheduler stopped");
  }
}

/**
 * Run a single poll cycle
 * @param {object} application - Indiekit application
 * @param {object} options - Plugin options
 */
async function runPollCycle(application, options) {
  const stateCollection = application.collections.get("conversation_state");
  const state =
    (await stateCollection.findOne({ _id: "poll_cursors" })) || {};

  // Poll Mastodon
  if (options.directPolling?.mastodon) {
    try {
      const { fetchMastodonNotifications } = await import(
        "../notifications/mastodon.js"
      );

      const mastodonUrl =
        process.env.MASTODON_URL || process.env.MASTODON_INSTANCE;
      const mastodonToken = process.env.MASTODON_ACCESS_TOKEN;

      if (mastodonUrl && mastodonToken) {
        const notifications = await fetchMastodonNotifications({
          url: mastodonUrl,
          accessToken: mastodonToken,
          sinceId: state.mastodon_since_id,
        });

        let stored = 0;
        for (const notification of notifications) {
          const canonicalUrl = notification.status_url
            ? await findCanonicalPost(application, notification.status_url)
            : null;

          if (canonicalUrl) {
            await upsertConversationItem(application, {
              canonical_url: canonicalUrl,
              source: "mastodon",
              type: notification.type,
              author: notification.author,
              content: notification.content,
              url: notification.url,
              bridgy_url: null,
              platform_id: notification.platform_id,
            });
            stored++;
          }
        }

        // Update cursor
        if (notifications.length > 0) {
          const latestId = notifications[0].raw_id;
          await stateCollection.findOneAndUpdate(
            { _id: "poll_cursors" },
            { $set: { mastodon_since_id: latestId } },
            { upsert: true },
          );
        }

        if (stored > 0) {
          console.info(
            `[Conversations] Mastodon: stored ${stored} new interactions`,
          );
        }
      }
    } catch (error) {
      console.error(
        "[Conversations] Mastodon poll error:",
        error.message,
      );
    }
  }

  // Poll Bluesky
  if (options.directPolling?.bluesky) {
    try {
      const { fetchBlueskyNotifications } = await import(
        "../notifications/bluesky.js"
      );

      const bskyIdentifier =
        process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_HANDLE;
      const bskyPassword = process.env.BLUESKY_PASSWORD;

      if (bskyIdentifier && bskyPassword) {
        const result = await fetchBlueskyNotifications({
          identifier: bskyIdentifier,
          password: bskyPassword,
          cursor: state.bluesky_cursor,
        });

        let stored = 0;
        for (const notification of result.items) {
          const canonicalUrl = notification.url
            ? await findCanonicalPost(application, notification.url)
            : null;

          if (canonicalUrl) {
            await upsertConversationItem(application, {
              canonical_url: canonicalUrl,
              source: "bluesky",
              type: notification.type,
              author: notification.author,
              content: notification.content,
              url: notification.url,
              bridgy_url: null,
              platform_id: notification.platform_id,
            });
            stored++;
          }
        }

        // Update cursor
        if (result.cursor) {
          await stateCollection.findOneAndUpdate(
            { _id: "poll_cursors" },
            { $set: { bluesky_cursor: result.cursor } },
            { upsert: true },
          );
        }

        if (stored > 0) {
          console.info(
            `[Conversations] Bluesky: stored ${stored} new interactions`,
          );
        }
      }
    } catch (error) {
      console.error(
        "[Conversations] Bluesky poll error:",
        error.message,
      );
    }
  }
}
