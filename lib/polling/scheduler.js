/**
 * Background polling scheduler
 * Polls Mastodon/Bluesky notifications and stores matching interactions
 * @module polling/scheduler
 */

import { findCanonicalPost } from "../matching/syndication-map.js";
import { upsertConversationItem } from "../storage/conversation-items.js";

const DEFAULT_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_POLL_INTERVAL = 30 * 60 * 1000; // 30 minutes

let pollTimer = null;
let currentInterval = DEFAULT_POLL_INTERVAL;
let pollContext = null; // Store context for interval recreation

/**
 * Start the background polling loop
 * @param {object} indiekit - Indiekit instance
 * @param {object} options - Plugin options
 */
export function startPolling(indiekit, options) {
  currentInterval = options.pollInterval || DEFAULT_POLL_INTERVAL;
  pollContext = { indiekit, options };

  // Run immediately, then on interval
  runPollCycle(indiekit, options).catch((error) => {
    console.error("[Conversations] Initial poll cycle error:", error.message);
  });

  scheduleNextPoll();
}

/**
 * Stop the polling scheduler
 */
export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollContext = null;
}

/**
 * Run a single poll cycle (exported for manual trigger from controller)
 * @param {object} indiekit - Indiekit instance (has .collections)
 * @param {object} options - Plugin options
 */
export async function runPollCycle(indiekit, options) {
  const stateCollection = indiekit.collections.get("conversation_state");
  const state =
    (await stateCollection.findOne({ _id: "poll_cursors" })) || {};

  // Detect enabled platforms from env vars
  const mastodonUrl =
    process.env.MASTODON_URL || process.env.MASTODON_INSTANCE;
  const mastodonToken = process.env.MASTODON_ACCESS_TOKEN;
  const hasMastodon = mastodonUrl && mastodonToken;

  const bskyIdentifier =
    process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_HANDLE;
  const bskyPassword = process.env.BLUESKY_PASSWORD;
  const hasBluesky = bskyIdentifier && bskyPassword;

  // Poll Mastodon
  if (hasMastodon) {
    await pollMastodon(indiekit, stateCollection, state, {
      url: mastodonUrl,
      accessToken: mastodonToken,
    });
  }

  // Poll Bluesky
  if (hasBluesky) {
    await pollBluesky(indiekit, stateCollection, state, {
      identifier: bskyIdentifier,
      password: bskyPassword,
    });
  }

  // Poll ActivityPub (auto-detect from local collections)
  // Detection runs at poll time because the AP endpoint may init after
  // the conversations plugin, so the collection isn't available at init.
  const hasActivityPub = await detectActivityPubSource(indiekit);
  if (hasActivityPub) {
    // Update config flag so the dashboard shows AP as enabled.
    // indiekit may be the Indiekit class or the application object
    // depending on whether called from startPolling or triggerPoll.
    const convConfig =
      indiekit.config?.application?.conversations || indiekit.conversations;
    if (convConfig && !convConfig.activitypubEnabled) {
      convConfig.activitypubEnabled = true;
    }
    await pollActivityPub(indiekit, stateCollection, state);
  }
}

/**
 * Poll Mastodon notifications and store matching interactions
 */
async function pollMastodon(indiekit, stateCollection, state, credentials) {
  try {
    const { fetchMastodonNotifications } = await import(
      "../notifications/mastodon.js"
    );

    const notifications = await fetchMastodonNotifications({
      url: credentials.url,
      accessToken: credentials.accessToken,
      sinceId: state.mastodon_since_id,
    });

    let stored = 0;

    for (const notification of notifications) {
      let canonicalUrl = null;

      if (
        notification.raw_type === "favourite" ||
        notification.raw_type === "reblog"
      ) {
        // For favourites/reblogs, lookup_url is YOUR syndicated post URL
        // This should match posts.properties.syndication
        if (notification.lookup_url) {
          canonicalUrl = await findCanonicalPost(
            indiekit,
            notification.lookup_url,
          );
        }
      } else if (notification.raw_type === "mention") {
        // For mentions (replies), we need to find which of YOUR posts
        // was replied to. If in_reply_to_id exists, we need to resolve it.
        // For now, try the lookup_url (the mention URL itself)
        // and fall back to checking if it's a reply to any known syndication
        if (notification.in_reply_to_id && credentials.url) {
          // Try to resolve the in_reply_to status URL
          const parentUrl = await resolvemastodonStatusUrl(
            credentials.url,
            credentials.accessToken,
            notification.in_reply_to_id,
          );
          if (parentUrl) {
            canonicalUrl = await findCanonicalPost(indiekit, parentUrl);
          }
        }
      }

      if (canonicalUrl) {
        await upsertConversationItem(indiekit, {
          canonical_url: canonicalUrl,
          source: "mastodon",
          type: notification.type,
          author: notification.author,
          content: notification.content,
          url: notification.url,
          bridgy_url: null,
          platform_id: notification.platform_id,
          created_at: notification.created_at,
        });
        stored++;
      }
    }

    // Update cursor and status
    const updateFields = {
      mastodon_last_poll: new Date().toISOString(),
      mastodon_last_error: null,
    };
    if (notifications.length > 0) {
      updateFields.mastodon_since_id = notifications[0].raw_id;
    }

    await stateCollection.findOneAndUpdate(
      { _id: "poll_cursors" },
      { $set: updateFields },
      { upsert: true },
    );

    if (stored > 0) {
      console.info(
        `[Conversations] Mastodon: stored ${stored}/${notifications.length} interactions`,
      );
    }

    // Reset interval on success
    resetInterval();
  } catch (error) {
    console.error("[Conversations] Mastodon poll error:", error.message);

    // Record error in state
    await stateCollection.findOneAndUpdate(
      { _id: "poll_cursors" },
      {
        $set: {
          mastodon_last_poll: new Date().toISOString(),
          mastodon_last_error: error.message,
        },
      },
      { upsert: true },
    );

    // Backoff on rate limit or auth errors
    if (error.status === 429 || error.status === 401) {
      backoff();
    }
  }
}

/**
 * Poll Bluesky notifications and store matching interactions
 */
async function pollBluesky(indiekit, stateCollection, state, credentials) {
  try {
    const { fetchBlueskyNotifications } = await import(
      "../notifications/bluesky.js"
    );

    const result = await fetchBlueskyNotifications({
      identifier: credentials.identifier,
      password: credentials.password,
      cursor: state.bluesky_cursor,
    });

    let stored = 0;

    for (const notification of result.items) {
      let canonicalUrl = null;

      if (notification.lookup_url) {
        // lookup_url is the web URL of YOUR post (converted from AT URI)
        canonicalUrl = await findCanonicalPost(
          indiekit,
          notification.lookup_url,
        );
      }

      if (canonicalUrl) {
        await upsertConversationItem(indiekit, {
          canonical_url: canonicalUrl,
          source: "bluesky",
          type: notification.type,
          author: notification.author,
          content: notification.content,
          url: notification.url,
          bridgy_url: null,
          platform_id: notification.platform_id,
          created_at: notification.created_at,
        });
        stored++;
      }
    }

    // Update cursor and status
    const updateFields = {
      bluesky_last_poll: new Date().toISOString(),
      bluesky_last_error: null,
    };
    if (result.cursor) {
      updateFields.bluesky_cursor = result.cursor;
    }

    await stateCollection.findOneAndUpdate(
      { _id: "poll_cursors" },
      { $set: updateFields },
      { upsert: true },
    );

    if (stored > 0) {
      console.info(
        `[Conversations] Bluesky: stored ${stored}/${result.items.length} interactions`,
      );
    }

    resetInterval();
  } catch (error) {
    console.error("[Conversations] Bluesky poll error:", error.message);

    await stateCollection.findOneAndUpdate(
      { _id: "poll_cursors" },
      {
        $set: {
          bluesky_last_poll: new Date().toISOString(),
          bluesky_last_error: error.message,
        },
      },
      { upsert: true },
    );

    if (error.status === 429 || error.status === 401) {
      backoff();
    }
  }
}

/**
 * Detect whether the ActivityPub endpoint is installed and has interaction data
 * @param {object} indiekit - Indiekit instance
 * @returns {Promise<boolean>}
 */
async function detectActivityPubSource(indiekit) {
  try {
    const ap_activities = indiekit.collections.get("ap_activities");
    if (!ap_activities) return false;
    // Collection exists — even if empty, polling is zero-cost (local DB query)
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll ActivityPub interactions from local ap_activities collection
 */
async function pollActivityPub(indiekit, stateCollection, state) {
  try {
    const { fetchActivityPubInteractions } = await import(
      "../notifications/activitypub.js"
    );

    const ap_activities = indiekit.collections.get("ap_activities");
    const ap_followers = indiekit.collections.get("ap_followers");

    if (!ap_activities) return;

    const result = await fetchActivityPubInteractions({
      ap_activities,
      ap_followers,
      since: state.activitypub_last_received_at || null,
    });

    let stored = 0;

    for (const interaction of result.items) {
      if (interaction.canonical_url) {
        await upsertConversationItem(indiekit, {
          canonical_url: interaction.canonical_url,
          source: "activitypub",
          type: interaction.type,
          author: interaction.author,
          content: interaction.content,
          url: interaction.url,
          bridgy_url: null,
          platform_id: interaction.platform_id,
          created_at: interaction.created_at,
        });
        stored++;
      }
    }

    // Update cursor and status
    const updateFields = {
      activitypub_last_poll: new Date().toISOString(),
      activitypub_last_error: null,
    };
    if (result.cursor) {
      updateFields.activitypub_last_received_at = result.cursor;
    }

    await stateCollection.findOneAndUpdate(
      { _id: "poll_cursors" },
      { $set: updateFields },
      { upsert: true },
    );

    if (stored > 0) {
      console.info(
        `[Conversations] ActivityPub: stored ${stored}/${result.items.length} interactions`,
      );
    }
  } catch (error) {
    console.error("[Conversations] ActivityPub poll error:", error.message);

    await stateCollection.findOneAndUpdate(
      { _id: "poll_cursors" },
      {
        $set: {
          activitypub_last_poll: new Date().toISOString(),
          activitypub_last_error: error.message,
        },
      },
      { upsert: true },
    );
  }
}

/**
 * Resolve a Mastodon status ID to its URL
 * Used to find the parent status of a mention/reply
 */
async function resolvemastodonStatusUrl(instanceUrl, accessToken, statusId) {
  try {
    const baseUrl = instanceUrl.replace(/\/$/, "");
    const response = await fetch(
      `${baseUrl}/api/v1/statuses/${statusId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!response.ok) return null;

    const status = await response.json();
    return status.url || null;
  } catch {
    return null;
  }
}

/**
 * Schedule the next poll cycle using currentInterval
 */
function scheduleNextPoll() {
  if (pollTimer) clearInterval(pollTimer);
  if (!pollContext) return;

  const { indiekit, options } = pollContext;
  pollTimer = setInterval(() => {
    runPollCycle(indiekit, options).catch((error) => {
      console.error("[Conversations] Poll cycle error:", error.message);
    });
  }, currentInterval);
}

/**
 * Double the poll interval (backoff on errors)
 */
function backoff() {
  if (!pollContext) return;

  const newInterval = Math.min(currentInterval * 2, MAX_POLL_INTERVAL);
  if (newInterval !== currentInterval) {
    currentInterval = newInterval;
    scheduleNextPoll();
  }
}

/**
 * Reset poll interval to default on success
 */
function resetInterval() {
  if (currentInterval !== DEFAULT_POLL_INTERVAL && pollContext) {
    currentInterval = DEFAULT_POLL_INTERVAL;
    scheduleNextPoll();
  }
}
