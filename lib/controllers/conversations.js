/**
 * Conversations controller
 * Admin dashboard + JF2 API + ingest endpoint
 * @module controllers/conversations
 */

import {
  classifyWebmention,
  generatePlatformId,
} from "../ingestion/webmention-classifier.js";
import { resolveCanonicalUrl } from "../matching/syndication-map.js";
import {
  getConversationItems,
  getConversationCount,
  getConversationSummaries,
  upsertConversationItem,
} from "../storage/conversation-items.js";
import {
  conversationItemToJf2,
  wmPropertyToType,
} from "../transforms/jf2.js";

/**
 * Admin dashboard — connection status + stats
 * GET /conversations
 */
async function dashboard(request, response) {
  const { application } = request.app.locals;

  try {
    const config = application.conversations || {};
    const stateCollection = application.collections?.get("conversation_state");

    // Get poll state
    let pollState = null;
    if (stateCollection) {
      pollState = await stateCollection.findOne({ _id: "poll_cursors" });
    }

    // Get stats
    const totalItems = await getConversationCount(application);
    const summaries = await getConversationSummaries(application, {
      limit: 10,
    });

    // Get recent items for activity log
    const itemsCollection = application.collections?.get("conversation_items");
    let recentItems = [];
    if (itemsCollection) {
      recentItems = await itemsCollection
        .find({})
        .sort({ received_at: -1 })
        .limit(10)
        .toArray();
    }

    // Get item counts by platform
    let platformCounts = {};
    if (itemsCollection) {
      const counts = await itemsCollection
        .aggregate([
          { $group: { _id: "$source", count: { $sum: 1 } } },
        ])
        .toArray();
      for (const c of counts) {
        platformCounts[c._id] = c.count;
      }
    }

    // Get item counts by type
    let typeCounts = {};
    if (itemsCollection) {
      const counts = await itemsCollection
        .aggregate([
          { $group: { _id: "$type", count: { $sum: 1 } } },
        ])
        .toArray();
      for (const c of counts) {
        typeCounts[c._id] = c.count;
      }
    }

    response.render("conversations", {
      title: response.__
        ? response.__("conversations.title")
        : "Conversations",
      config,
      pollState,
      totalItems,
      summaries,
      recentItems,
      platformCounts,
      typeCounts,
      baseUrl: config.mountPath || "/conversations",
    });
  } catch (error) {
    console.error("[Conversations] Dashboard error:", error.message);
    response.status(500).render("conversations", {
      title: "Conversations",
      error: error.message,
      config: {},
      totalItems: 0,
      summaries: [],
      recentItems: [],
      platformCounts: {},
      typeCounts: {},
    });
  }
}

/**
 * JF2-compatible mentions API
 * GET /conversations/api/mentions
 * Supports same query params as webmention-io: target, wm-property, per-page, page
 */
async function apiMentions(request, response) {
  const { application } = request.app.locals;

  try {
    const target = request.query.target || null;
    const wmProperty = request.query["wm-property"] || null;
    const perPage = Math.min(
      Number(request.query["per-page"]) || 50,
      10000,
    );
    const page = Number(request.query.page) || 0;

    const queryOptions = {
      limit: perPage,
      skip: page * perPage,
    };

    // Map wm-property to internal type
    if (wmProperty) {
      const internalType = wmPropertyToType(wmProperty);
      if (internalType) {
        queryOptions.type = internalType;
      }
    }

    let items;
    if (target) {
      // Match with and without trailing slash (same as webmention-io)
      const targetClean = target.replace(/\/$/, "");
      const collection = application.collections?.get("conversation_items");

      if (!collection) {
        return response.status(503).json({ error: "Database unavailable" });
      }

      const query = {
        canonical_url: { $in: [targetClean, targetClean + "/"] },
      };
      if (queryOptions.type) query.type = queryOptions.type;

      items = await collection
        .find(query)
        .sort({ received_at: -1 })
        .skip(queryOptions.skip || 0)
        .limit(queryOptions.limit)
        .toArray();
    } else {
      items = await getConversationItems(application, null, queryOptions);
    }

    const children = items.map(conversationItemToJf2);

    response.set("Cache-Control", "public, max-age=60");
    response.json({
      type: "feed",
      name: "Conversations",
      children,
    });
  } catch (error) {
    console.error("[Conversations] API error:", error.message);
    response.status(500).json({ error: "Failed to fetch conversations" });
  }
}

/**
 * Connection status API (for health checks)
 * GET /conversations/api/status
 */
async function apiStatus(request, response) {
  const { application } = request.app.locals;

  try {
    const config = application.conversations || {};
    const stateCollection = application.collections?.get("conversation_state");

    let pollState = null;
    if (stateCollection) {
      pollState = await stateCollection.findOne({ _id: "poll_cursors" });
    }

    const totalItems = await getConversationCount(application);

    response.json({
      status: "ok",
      mastodon: {
        enabled: !!config.mastodonEnabled,
        lastCursor: pollState?.mastodon_since_id || null,
        lastError: pollState?.mastodon_last_error || null,
        lastPoll: pollState?.mastodon_last_poll || null,
      },
      bluesky: {
        enabled: !!config.blueskyEnabled,
        lastCursor: pollState?.bluesky_cursor || null,
        lastError: pollState?.bluesky_last_error || null,
        lastPoll: pollState?.bluesky_last_poll || null,
      },
      activitypub: {
        enabled: !!config.activitypubEnabled,
        lastCursor: pollState?.activitypub_last_received_at || null,
        lastError: pollState?.activitypub_last_error || null,
        lastPoll: pollState?.activitypub_last_poll || null,
      },
      totalItems,
    });
  } catch (error) {
    response.status(500).json({ status: "error", error: error.message });
  }
}

/**
 * Trigger manual poll cycle (admin only)
 * POST /conversations/poll
 */
async function triggerPoll(request, response) {
  try {
    const { runPollCycle } = await import("../polling/scheduler.js");
    const { application } = request.app.locals;
    const config = application.conversations || {};

    await runPollCycle(application, config);

    // Redirect back to dashboard
    response.redirect(config.mountPath || "/conversations");
  } catch (error) {
    console.error("[Conversations] Manual poll error:", error.message);
    response.redirect(
      (request.app.locals.application?.conversations?.mountPath ||
        "/conversations") + "?error=poll_failed",
    );
  }
}

/**
 * Ingest a webmention
 * POST /conversations/ingest
 * Accepts webmention data (JSON or form-encoded), classifies and stores it
 */
async function ingest(request, response) {
  const { application } = request.app.locals;
  const siteUrl = application.url || process.env.SITE_URL;

  try {
    const webmention = request.body;

    // Validate required fields
    if (!webmention?.source || !webmention?.target) {
      return response.status(400).json({
        error: "source and target are required",
      });
    }

    // Validate URLs
    try {
      new URL(webmention.source);
      new URL(webmention.target);
    } catch {
      return response.status(400).json({
        error: "source and target must be valid URLs",
      });
    }

    // source and target must differ
    if (webmention.source === webmention.target) {
      return response.status(400).json({
        error: "source and target must be different URLs",
      });
    }

    // Classify the webmention
    const classification = classifyWebmention(webmention);

    // Resolve canonical URL (target may be a syndication URL)
    const canonicalUrl = await resolveCanonicalUrl(
      application,
      webmention.target,
      siteUrl,
    );

    // Build conversation item
    const item = {
      canonical_url: canonicalUrl,
      source: classification.source,
      type: classification.type,
      author: webmention.author || {
        name: "Unknown",
        url: webmention.source,
      },
      content: webmention.content?.text || webmention.content?.html || null,
      url: webmention.source,
      bridgy_url: classification.bridgy_url,
      platform_id: generatePlatformId(webmention),
    };

    await upsertConversationItem(application, item);

    response.status(202).json({ status: "accepted", classification });
  } catch (error) {
    console.error("[Conversations] Ingest error:", error.message);
    response.status(500).json({ error: error.message });
  }
}

export const conversationsController = {
  dashboard,
  apiMentions,
  apiStatus,
  triggerPoll,
  ingest,
};
