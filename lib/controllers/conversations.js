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

    // Get item counts by channel (ingestion path)
    let channelCounts = {};
    if (itemsCollection) {
      const counts = await itemsCollection
        .aggregate([
          { $group: { _id: "$channel", count: { $sum: 1 } } },
        ])
        .toArray();
      for (const c of counts) {
        channelCounts[c._id] = c.count;
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
      channelCounts,
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
      channelCounts: {},
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

    // Filter out self-interactions from own Bluesky account
    const selfBskyHandle = (process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_HANDLE || "").replace(/^@+/, "").toLowerCase();
    if (selfBskyHandle) {
      const selfBskyUrl = "https://bsky.app/profile/" + selfBskyHandle;
      items = items.filter(item => (item.author?.url || "").toLowerCase() !== selfBskyUrl);
    }

    const children = items.map(conversationItemToJf2);

    // Enrich with owner replies from the posts collection
    // Owner replies are Micropub posts with in-reply-to matching an interaction URL.
    // We collect reply URLs from conversations DB items, but also need to find
    // owner replies to interactions that only exist in webmention.io (e.g., Bluesky
    // replies via Bridgy). Strategy: query for reply URLs from conversations items,
    // plus find owner posts replying to any URL that the frontend might display
    // by checking the canonical post's syndication targets.
    const replyUrls = children
      .filter((c) => c["wm-property"] === "in-reply-to")
      .map((c) => c.url)
      .filter(Boolean);

    const postsCollection = application.collections?.get("posts");
    if (postsCollection) {
      const siteUrl = application.publication?.me || application.url || "";
      const ownerName =
        process.env.AUTHOR_NAME ||
        (siteUrl ? new URL(siteUrl).hostname : "Owner");

      // Find the canonical post to get its syndication URLs
      // Interactions on syndicated copies (e.g., Bluesky replies to the bsky.app
      // syndicated post) arrive via webmention.io but not conversations DB.
      // Owner replies to those interactions have in-reply-to pointing to external
      // URLs (bsky.app, mastodon, etc.) — we need to find them too.
      let syndicationDomains = [];
      if (target) {
        const targetWithout = target.endsWith("/") ? target.slice(0, -1) : target;
        const canonicalPost = await postsCollection.findOne({
          $or: [
            { "properties.url": target },
            { "properties.url": targetWithout },
          ],
        });
        if (canonicalPost?.properties?.syndication) {
          const syns = Array.isArray(canonicalPost.properties.syndication)
            ? canonicalPost.properties.syndication
            : [canonicalPost.properties.syndication];
          for (const syn of syns) {
            try {
              const domain = new URL(syn).hostname;
              if (domain && !domain.includes(new URL(siteUrl).hostname)) {
                syndicationDomains.push(domain);
              }
            } catch { /* skip invalid URLs */ }
          }
        }
      }

      // Build query: replies to known conversation URLs OR replies to URLs
      // on syndication domains (for webmention.io items not in our DB)
      const orClauses = [];
      if (replyUrls.length > 0) {
        orClauses.push({ "properties.in-reply-to": { $in: replyUrls } });
      }
      for (const domain of syndicationDomains) {
        orClauses.push({
          "properties.in-reply-to": { $regex: domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
        });
      }

      let ownerPosts = [];
      if (orClauses.length > 0) {
        ownerPosts = await postsCollection
          .find({ $or: orClauses })
          .sort({ "properties.published": -1 })
          .limit(50)
          .toArray();
      }

      for (const post of ownerPosts) {
        const inReplyTo = post.properties?.["in-reply-to"];
        if (!inReplyTo || typeof inReplyTo !== "string") continue;

        // Include syndication URLs so the frontend can match the Bridgy
        // echo (webmention.io returns the syndicated URL as the item's url)
        const syndication = post.properties?.syndication;
        const synUrls = Array.isArray(syndication)
          ? syndication
          : syndication ? [syndication] : [];

        children.push({
          type: "entry",
          "wm-id": `owner-reply-${post._id}`,
          "wm-property": "in-reply-to",
          "wm-target": target || "",
          "wm-received": post.properties?.published || "",
          author: {
            type: "card",
            name: ownerName,
            url: siteUrl,
            photo: process.env.AUTHOR_AVATAR || "",
          },
          url: post.properties?.url || "",
          published: post.properties?.published || "",
          content: {
            text: post.properties?.content?.text || "",
            html: post.properties?.content?.html || "",
          },
          is_owner: true,
          parent_url: inReplyTo,
          syndication: synUrls,
        });
      }
    }

    // Build owner identity URLs so the frontend can detect self-authored
    // items from any source (webmention.io, Bridgy, etc.). The owner may
    // syndicate replies via Bluesky, self-hosted AP, or external Mastodon —
    // each produces a different author URL. All are derived from env vars
    // so any deployment can use this without hardcoding.
    const ownerUrls = [];
    const siteUrlClean = (application.publication?.me || application.url || "").replace(/\/$/, "");
    if (siteUrlClean) {
      ownerUrls.push(siteUrlClean);
      // Self-hosted ActivityPub actor
      const apHandle = process.env.ACTIVITYPUB_HANDLE;
      if (apHandle) {
        ownerUrls.push(siteUrlClean + "/activitypub/users/" + apHandle);
      }
    }
    const bskyHandle = (process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_HANDLE || "").replace(/^@+/, "").toLowerCase();
    if (bskyHandle) {
      ownerUrls.push("https://bsky.app/profile/" + bskyHandle);
    }
    const mastodonInstance = (process.env.MASTODON_INSTANCE || "").replace(/\/$/, "");
    const mastodonUser = process.env.MASTODON_USER || "";
    if (mastodonInstance && mastodonUser) {
      ownerUrls.push(mastodonInstance + "/@" + mastodonUser);
    }

    response.set("Cache-Control", "public, max-age=60");
    response.json({
      type: "feed",
      name: "Conversations",
      children,
      owner_urls: ownerUrls,
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
      channel: "webhook",
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
