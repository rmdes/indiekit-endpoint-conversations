/**
 * Conversations controller
 * Admin UI + JSON API for unified conversation views
 * @module controllers/conversations
 */

import {
  classifyWebmention,
  generatePlatformId,
} from "../ingestion/webmention-classifier.js";
import { resolveCanonicalUrl } from "../matching/syndication-map.js";
import {
  getConversationItems,
  getConversationSummaries,
  upsertConversationItem,
} from "../storage/conversation-items.js";

/**
 * List conversations (admin UI)
 * GET /conversations
 */
async function list(request, response) {
  const { application } = request.app.locals;
  const page = Number.parseInt(request.query.page) || 1;
  const limit = 50;
  const skip = (page - 1) * limit;

  try {
    const summaries = await getConversationSummaries(application, {
      limit,
      skip,
    });

    response.render("conversations", {
      title: "Conversations",
      summaries,
      page,
      baseUrl: application.conversations?.mountPath || "/conversations",
    });
  } catch (error) {
    console.error("[Conversations] List error:", error.message);
    response.status(500).render("conversations", {
      title: "Conversations",
      summaries: [],
      error: error.message,
    });
  }
}

/**
 * Conversation detail for a post (admin UI)
 * GET /conversations/post?url=...
 */
async function detail(request, response) {
  const { application } = request.app.locals;
  const { url } = request.query;

  if (!url) {
    return response.status(400).render("conversation-detail", {
      title: "Conversation",
      items: [],
      error: "URL parameter required",
    });
  }

  try {
    const items = await getConversationItems(application, url);

    // Group by source
    const grouped = {
      webmention: items.filter((i) => i.source === "webmention"),
      mastodon: items.filter((i) => i.source === "mastodon"),
      bluesky: items.filter((i) => i.source === "bluesky"),
    };

    response.render("conversation-detail", {
      title: "Conversation",
      canonicalUrl: url,
      items,
      grouped,
      baseUrl: application.conversations?.mountPath || "/conversations",
    });
  } catch (error) {
    console.error("[Conversations] Detail error:", error.message);
    response.status(500).render("conversation-detail", {
      title: "Conversation",
      items: [],
      error: error.message,
    });
  }
}

/**
 * JSON API — get conversation items for a canonical URL
 * GET /conversations/api/post?url=...
 */
async function apiPost(request, response) {
  const { application } = request.app.locals;
  const { url, source } = request.query;

  if (!url) {
    return response.status(400).json({ error: "url parameter required" });
  }

  try {
    const options = {};
    if (source) options.source = source;

    const items = await getConversationItems(application, url, options);

    // Group by source for easy consumption
    const grouped = {};
    for (const item of items) {
      if (!grouped[item.source]) grouped[item.source] = [];
      grouped[item.source].push(item);
    }

    response.json({
      canonical_url: url,
      total: items.length,
      items,
      grouped,
    });
  } catch (error) {
    console.error("[Conversations] API error:", error.message);
    response.status(500).json({ error: error.message });
  }
}

/**
 * Ingest a webmention
 * POST /conversations/ingest
 * Accepts webmention data, classifies it, and stores it
 */
async function ingest(request, response) {
  const { application } = request.app.locals;
  const siteUrl = application.url || process.env.SITE_URL;

  try {
    const webmention = request.body;

    if (!webmention.source || !webmention.target) {
      return response.status(400).json({
        error: "source and target are required",
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

export const conversationsController = { list, detail, apiPost, ingest };
