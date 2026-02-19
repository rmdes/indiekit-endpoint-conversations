import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { conversationsController } from "./lib/controllers/conversations.js";
import { createIndexes } from "./lib/storage/conversation-items.js";

const defaults = {
  mountPath: "/conversations",
  useGranary: false,
  granaryUrl: "https://granary.io",
};

const router = express.Router();

export default class ConversationsEndpoint {
  name = "Conversations endpoint";

  /**
   * @param {object} options - Plugin options
   * @param {string} [options.mountPath] - Path to mount endpoint
   * @param {number} [options.pollInterval] - Polling interval in ms (default 300000)
   * @param {boolean} [options.useGranary] - Use Granary REST API for format conversion
   * @param {string} [options.granaryUrl] - Custom Granary instance URL
   */
  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  get localesDirectory() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "conversations.title",
      requiresDatabase: true,
    };
  }

  /**
   * Protected routes (require authentication)
   * Admin dashboard only
   */
  get routes() {
    router.get("/", conversationsController.dashboard);

    // Manual poll trigger (admin only)
    router.post("/poll", conversationsController.triggerPoll);

    return router;
  }

  /**
   * Public routes (no authentication required)
   * JF2 API + ingest endpoint + status
   */
  get routesPublic() {
    const publicRouter = express.Router();

    // JF2-compatible mentions API (matches webmention-io format)
    publicRouter.get("/api/mentions", conversationsController.apiMentions);

    // Connection status (for health checks)
    publicRouter.get("/api/status", conversationsController.apiStatus);

    // Webmention ingestion (called by Bridgy or external services)
    publicRouter.post("/ingest", conversationsController.ingest);

    return publicRouter;
  }

  /**
   * Initialize plugin
   * @param {object} Indiekit - Indiekit instance
   */
  init(Indiekit) {
    // Register MongoDB collections
    Indiekit.addCollection("conversation_items");
    Indiekit.addCollection("conversation_state");

    Indiekit.addEndpoint(this);

    // Store options on the application for access by controllers
    if (!Indiekit.config.application.conversations) {
      Indiekit.config.application.conversations = this.options;
    }

    if (Indiekit.database) {
      // Create indexes
      createIndexes(Indiekit).catch((error) => {
        console.warn(
          "[Conversations] Index creation failed:",
          error.message,
        );
      });

      // Auto-detect credentials and start polling
      const hasMastodon =
        process.env.MASTODON_ACCESS_TOKEN &&
        (process.env.MASTODON_URL || process.env.MASTODON_INSTANCE);
      const hasBluesky =
        (process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_HANDLE) &&
        process.env.BLUESKY_PASSWORD;

      // ActivityPub: auto-detect from shared collection registry
      // The AP endpoint registers ap_activities via Indiekit.addCollection()
      const hasActivityPub = Indiekit.collections.has("ap_activities");

      if (hasMastodon || hasBluesky || hasActivityPub) {
        // Store detected platforms for dashboard status
        Indiekit.config.application.conversations = {
          ...this.options,
          mastodonEnabled: !!hasMastodon,
          blueskyEnabled: !!hasBluesky,
          activitypubEnabled: !!hasActivityPub,
        };

        import("./lib/polling/scheduler.js")
          .then(({ startPolling }) => {
            startPolling(Indiekit, this.options);
          })
          .catch((error) => {
            console.error(
              "[Conversations] Polling scheduler failed to start:",
              error.message,
            );
          });
      }
    }
  }
}
