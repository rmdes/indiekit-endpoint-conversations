# @rmdes/indiekit-endpoint-conversations

Conversation aggregation endpoint for [Indiekit](https://getindiekit.com/). Polls Mastodon, Bluesky, and ActivityPub notifications, stores interactions in MongoDB, and serves them as a JF2-compatible API — including threaded owner replies.

## Features

- **Multi-platform polling** — Mastodon, Bluesky, and native ActivityPub (via Fedify)
- **JF2 API** — serves likes, reposts, and replies in webmention-compatible format
- **Owner reply threading** — enriches API responses with the site owner's replies from the `posts` collection, with threading metadata
- **Webmention ingestion** — accepts incoming webmentions from Bridgy or external services
- **Admin dashboard** — connection status, polling stats, platform health
- **Syndication URL matching** — resolves canonical post URLs from syndicated copies

## Installation

```bash
npm install @rmdes/indiekit-endpoint-conversations
```

```javascript
// indiekit.config.js
import ConversationsEndpoint from "@rmdes/indiekit-endpoint-conversations";

export default {
  plugins: [
    new ConversationsEndpoint({
      mountPath: "/conversations",
    }),
  ],
};
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MASTODON_ACCESS_TOKEN` | For Mastodon | Mastodon API access token |
| `MASTODON_URL` or `MASTODON_INSTANCE` | For Mastodon | Mastodon instance URL |
| `BLUESKY_IDENTIFIER` or `BLUESKY_HANDLE` | For Bluesky | Bluesky account identifier |
| `BLUESKY_PASSWORD` | For Bluesky | Bluesky app password |
| `AUTHOR_NAME` | Optional | Owner display name (falls back to site hostname) |
| `AUTHOR_AVATAR` | Optional | Owner avatar URL |

ActivityPub polling is auto-detected when `@rmdes/indiekit-endpoint-activitypub` is installed.

## API

### GET /conversations/api/mentions

Returns interactions for a target URL in JF2 feed format. Compatible with the webmention.io API shape used by `@chrisburnell/eleventy-cache-webmentions`.

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `target` | string | Target URL to fetch interactions for |
| `wm-property` | string | Filter by type: `like-of`, `repost-of`, `in-reply-to` |
| `per-page` | number | Results per page (default: 50, max: 100) |
| `page` | number | Page number (default: 0) |

**Response:**

```json
{
  "type": "feed",
  "name": "Conversations",
  "children": [
    {
      "type": "entry",
      "wm-id": "conv-mastodon:12345",
      "wm-property": "in-reply-to",
      "wm-target": "https://example.com/posts/hello",
      "author": {
        "type": "card",
        "name": "Jane Doe",
        "url": "https://mastodon.social/@jane",
        "photo": "https://..."
      },
      "url": "https://mastodon.social/@jane/67890",
      "published": "2026-03-11T16:19:52.652Z",
      "platform": "mastodon",
      "content": {
        "html": "<p>Great post!</p>",
        "text": "Great post!"
      }
    },
    {
      "type": "entry",
      "wm-id": "owner-reply-abc123",
      "wm-property": "in-reply-to",
      "wm-target": "https://example.com/posts/hello",
      "author": {
        "type": "card",
        "name": "Site Owner",
        "url": "https://example.com",
        "photo": "https://..."
      },
      "url": "https://example.com/replies/2026/03/11/65e12",
      "published": "2026-03-11T17:00:00.000Z",
      "content": {
        "html": "<p>Thanks!</p>",
        "text": "Thanks!"
      },
      "is_owner": true,
      "parent_url": "https://mastodon.social/@jane/67890"
    }
  ]
}
```

### Owner Reply Enrichment

When the API returns replies (`wm-property: "in-reply-to"`), it checks the Indiekit `posts` collection for owner posts whose `properties.in-reply-to` matches any reply's `url`. Matching owner posts are appended to the response with two extra fields:

| Field | Type | Description |
|-------|------|-------------|
| `is_owner` | boolean | Always `true` for owner replies |
| `parent_url` | string | The URL of the interaction this reply responds to |

The frontend uses `parent_url` to thread the owner's reply under the correct parent interaction. See [`indiekit-eleventy-theme`](https://github.com/rmdes/indiekit-eleventy-theme) for the client-side threading implementation.

### GET /conversations/api/status

Returns connection health and platform status.

### POST /conversations/ingest

Accepts incoming webmentions. Body: `{ source, target }`.

### POST /conversations/poll (authenticated)

Triggers an immediate poll of all configured platforms.

## Architecture

```
Mastodon API ──┐
Bluesky API  ──┼──> Scheduler ──> conversation_items (MongoDB)
ActivityPub  ──┘                         │
                                         v
               GET /api/mentions ──> JF2 response
                                    + owner reply enrichment
                                      (from posts collection)
```

### Collections

| Collection | Purpose |
|------------|---------|
| `conversation_items` | Stored interactions (likes, reposts, replies) |
| `conversation_state` | Polling state (last poll timestamps, cursors) |

### Dependencies

- **`@rmdes/indiekit-endpoint-activitypub`** — Optional. When installed, the scheduler also polls native ActivityPub interactions from the `ap_interactions` collection.
- **`indiekit-eleventy-theme`** — The theme's `webmentions.js` consumes the `/api/mentions` endpoint and threads owner replies using the `is_owner` and `parent_url` fields.
- **`@rmdes/indiekit-endpoint-comments`** — Handles native comment replies (not platform interactions). Owner replies to native comments go through the comments API, not this plugin.

## License

MIT
