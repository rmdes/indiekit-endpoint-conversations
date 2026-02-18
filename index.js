import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { conversationsController } from "./lib/controllers/conversations.js";
import { createIndexes } from "./lib/storage/conversation-items.js";

const defaults = {
  mountPath: "/conversations",
  directPolling: {
    mastodon: false,
    bluesky: false,
  },
  useGranary: false,
  granaryUrl: "https://granary.io",
};

const router = express.Router();

export default class ConversationsEndpoint {
  name = "Conversations endpoint";

  /**
   * @param {object} options - Plugin options
   * @param {string} [options.mountPath] - Path to mount endpoint
   * @param {object} [options.directPolling] - Enable direct API polling
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

  get routes() {
    // Admin UI
    router.get("/", conversationsController.list);
    router.get("/post", conversationsController.detail);

    // JSON API (public-ish, for Eleventy client-side fetch)
    router.get("/api/post", conversationsController.apiPost);

    // Webmention ingestion endpoint
    router.post("/ingest", conversationsController.ingest);

    return router;
  }

  get routesPublic() {
    const publicRouter = express.Router();

    // JSON API must be public for Eleventy client-side JS to fetch
    publicRouter.get("/api/post", conversationsController.apiPost);

    // Webmention ingestion can be called by Bridgy or webmention.io
    publicRouter.post("/ingest", conversationsController.ingest);

    return publicRouter;
  }

  init(indiekit) {
    console.info("[Conversations] Initializing endpoint-conversations plugin");

    // Register MongoDB collections
    indiekit.addCollection("conversation_items");
    indiekit.addCollection("conversation_state");

    console.info("[Conversations] Registered MongoDB collections");

    indiekit.addEndpoint(this);

    // Store options on the application for access by controllers
    if (!indiekit.config.application.conversations) {
      indiekit.config.application.conversations = this.options;
    }

    if (indiekit.database) {
      // Create indexes
      createIndexes(indiekit).catch((error) => {
        console.warn(
          "[Conversations] Index creation failed:",
          error.message,
        );
      });

      // Start direct polling if enabled
      if (
        this.options.directPolling.mastodon ||
        this.options.directPolling.bluesky
      ) {
        import("./lib/polling/scheduler.js")
          .then(({ startPolling }) => {
            startPolling(indiekit, this.options);
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
