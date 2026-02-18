# Plan: Rework indiekit-endpoint-conversations v2.0

## Status: PENDING
## Created: 2025-02-17

---

## Context

The conversations plugin (v1.0.0) was deployed to rmendes.net but shows an empty state. Root cause: direct polling is disabled in config, and no external service is POSTing to the `/ingest` endpoint. The plugin also duplicates frontend views that already exist at `/interactions/` (powered by the webmention-io plugin).

### What Already Works (Don't Touch)

- **`@rmdes/indiekit-endpoint-webmention-io`** — polls webmention.io, caches in MongoDB `webmentions` collection, serves JF2 at `/webmentions/api/mentions`, provides admin moderation dashboard. This is the primary webmention system and stays as-is.
- **Eleventy theme `/interactions/`** — Alpine.js page with outbound (your activity) and inbound (received webmentions) tabs. Fetches from `/webmentions/api/mentions`.
- **Per-post webmentions component** — build-time + runtime webmentions at the bottom of each post.

### The Problem

1. Config doesn't enable direct polling (`directPolling.mastodon: false`, `directPolling.bluesky: false`)
2. Env vars exist (`BLUESKY_HANDLE`, `BLUESKY_PASSWORD`, `MASTODON_INSTANCE`, `MASTODON_ACCESS_TOKEN`) but plugin doesn't read them for auto-configuration
3. Admin UI is a duplicate interaction list instead of a configuration/status dashboard
4. The API serves a custom schema incompatible with the JF2 format the frontend expects
5. Granary client exists but is dead code (never called)

### The Vision

The conversations plugin becomes:
- **Backend**: Admin dashboard for configuring and monitoring social connections (Bluesky, Mastodon, Bridgy, Granary)
- **Data layer**: Enrichment pipeline that collects interactions from direct APIs, classifies by platform, deduplicates, and serves JF2-compatible JSON
- **Frontend**: NO separate `/conversations` page for end users — enriched data feeds into the existing `/interactions/` page via a parallel API

---

## Architecture After Rework

```
                         ┌──────────────────────────────────────┐
                         │         Frontend (/interactions/)     │
                         │  Fetches from BOTH APIs, merges,      │
                         │  deduplicates by wm-id/platform_id    │
                         └──────┬─────────────────┬──────────────┘
                                │                 │
                    ┌───────────▼──────┐  ┌──────▼───────────────┐
                    │ /webmentions/    │  │ /conversations/       │
                    │ api/mentions     │  │ api/mentions          │
                    │ (JF2 format)     │  │ (JF2 format + platform│
                    │                  │  │  enrichment)          │
                    │ webmention-io    │  │ conversations plugin  │
                    │ plugin           │  │                       │
                    └───────┬──────────┘  └──────┬───────────────┘
                            │                     │
                    ┌───────▼──────────┐  ┌──────▼───────────────┐
                    │ MongoDB:         │  │ MongoDB:              │
                    │ webmentions      │  │ conversation_items    │
                    │ (from wm.io)     │  │ (from direct APIs +   │
                    │                  │  │  Bridgy webhooks)     │
                    └──────────────────┘  └──────────────────────┘
                                                  ▲
                              ┌────────────────────┼─────────────┐
                              │                    │             │
                     Bluesky API          Mastodon API    Bridgy webhook
                     (polling)            (polling)       (POST /ingest)
```

---

## Tasks

### Task 1: Rework plugin config to auto-detect credentials
- [ ] Read Bluesky/Mastodon env vars in constructor and auto-enable polling when credentials are present
- [ ] Add explicit config options for credentials (with env var fallbacks)
- [ ] Remove the need for `directPolling.mastodon: true` toggle — if token is set, poll
- [ ] Add `pollInterval` config option (default 5 min)

**Files:** `index.js`

**Recycle:** Constructor pattern stays, just smarter defaults.

### Task 2: Rework admin views into connection dashboard
- [ ] Replace `conversations.njk` (list view) with a status dashboard showing:
  - Connection cards: Bluesky (connected/disconnected, last poll, items collected, errors)
  - Connection cards: Mastodon (same)
  - Connection cards: Bridgy webhook (URL to configure, items received)
  - Connection cards: Granary (enabled/disabled, URL)
  - Overall stats: total items, items by platform, items by type
  - Manual "Poll Now" button per platform
  - Recent activity log (last 10 items ingested)
- [ ] Drop `conversation-detail.njk` (per-post detail view — this lives on /interactions/)
- [ ] Add `POST /poll` admin route to trigger manual poll cycle
- [ ] Add `GET /api/status` public route returning connection status as JSON

**Files:** `views/conversations.njk` (replace), `views/conversation-detail.njk` (delete), `lib/controllers/conversations.js` (rework `list` and `detail`), `locales/en.json` (update)

**Recycle:** Template structure from `conversations.njk` (extends document.njk, SVG icons). Controller `list()` becomes `dashboard()`.

### Task 3: Rework API to serve JF2-compatible format
- [ ] Change `GET /api/post` → `GET /api/mentions` (consistent with webmention-io plugin)
- [ ] Transform `conversation_items` → JF2 format matching webmention-io response:
  ```json
  {
    "type": "feed",
    "name": "Conversations",
    "children": [{
      "type": "entry",
      "wm-id": "conv-mastodon-123456",
      "wm-property": "in-reply-to",
      "wm-target": "https://rmendes.net/post-url",
      "wm-received": "2025-02-13T10:00:00.000Z",
      "published": "2025-02-13T09:00:00.000Z",
      "author": { "type": "card", "name": "...", "url": "...", "photo": "..." },
      "content": { "html": "...", "text": "..." },
      "url": "https://source-url",
      "platform": "mastodon",
      "platform-id": "mastodon:123456",
      "confidence": "high"
    }]
  }
  ```
- [ ] Support same query params as webmention-io: `target`, `wm-property`, `per-page`, `page`
- [ ] Map internal types to wm-property: reply → in-reply-to, like → like-of, repost → repost-of, mention → mention-of
- [ ] Prefix `wm-id` with `conv-` to avoid collision with webmention-io IDs during frontend merge
- [ ] Add `platform` and `platform-id` fields (JF2 extension — frontend uses for icons)

**Files:** `lib/controllers/conversations.js` (rework `apiPost`), new `lib/transforms/jf2.js` (conversion layer)

**Recycle:** `apiPost()` controller structure. `getConversationItems()` and `getConversationSummaries()` storage functions.

### Task 4: Wire Granary client into enrichment pipeline
- [ ] In the ingest flow, optionally pass incoming data through Granary for format normalization
- [ ] In the polling flow, use Granary to convert AT Protocol / ActivityStreams data to microformats2 when `useGranary: true`
- [ ] Keep Granary optional — direct API parsing works without it

**Files:** `lib/ingestion/granary-client.js` (currently dead code — wire in), `lib/polling/scheduler.js` (add Granary step), `lib/controllers/conversations.js` (add Granary step to ingest)

**Recycle:** `granary-client.js` entirely — it's already written, just not called.

### Task 5: Improve polling reliability
- [ ] Add rate-limit detection and backoff (Mastodon: 429 response, Bluesky: rate limit headers)
- [ ] Add exponential backoff on repeated errors (max 30 min)
- [ ] Replace module-level `pollTimer` global with a proper state object
- [ ] Add per-platform error tracking in `conversation_state` collection
- [ ] Log less on success (only when items found), log more on errors

**Files:** `lib/polling/scheduler.js`, `lib/notifications/bluesky.js`, `lib/notifications/mastodon.js`

**Recycle:** All three files — improve in place, don't rewrite.

### Task 6: Update Eleventy theme to merge both APIs
- [ ] In `interactions.njk` inbound tab: fetch from BOTH `/webmentions/api/mentions` and `/conversations/api/mentions`
- [ ] Merge results, deduplicate by matching `wm-id` and `url` fields
- [ ] Add platform icons (Bluesky butterfly, Mastodon elephant, Web globe) using the `platform` field from conversations API
- [ ] Fall back gracefully if conversations API returns 404/503 (plugin not installed)
- [ ] In `js/webmentions.js` per-post component: same dual-fetch + merge pattern

**Files:** `indiekit-eleventy-theme/interactions.njk`, `indiekit-eleventy-theme/js/webmentions.js`

**Recycle:** Existing fetch/display logic — add second fetch source alongside.

### Task 7: Update Cloudron config to enable polling
- [ ] Update `indiekit.config.js.template` conversations config:
  ```javascript
  "@rmdes/indiekit-endpoint-conversations": {
    mountPath: "/conversations",
    // Direct polling auto-detects from env vars — no explicit toggle needed
  },
  ```
- [ ] Verify env vars are passed through to the Indiekit process (check start.sh)

**Files:** `indiekit-cloudron/indiekit.config.js.template`

**Recycle:** Existing config block — simplify.

### Task 8: Update locales
- [ ] Rework `en.json` for dashboard UI strings (connection status, poll actions, error messages)
- [ ] Add translations for: fr, de, nl, es, pt, sv (matching other plugins)
- [ ] Remove unused strings (list/detail view strings that no longer exist)

**Files:** `locales/en.json` (rework), `locales/{fr,de,nl,es,pt,sv}.json` (create)

**Recycle:** Locale structure from other plugins.

### Task 9: Update package.json and CLAUDE.md
- [ ] Bump version to 2.0.0 (breaking change — API route rename, admin UI rework)
- [ ] Update description
- [ ] Review dependencies — remove `masto` and `@atproto/api` from optionalDependencies if still unused (direct HTTP fetch)
- [ ] Update CLAUDE.md to reflect new architecture

**Files:** `package.json`, `CLAUDE.md`

### Task 10: Deploy and verify
- [ ] npm publish `@rmdes/indiekit-endpoint-conversations@2.0.0`
- [ ] Update Cloudron Dockerfile version
- [ ] Update indiekit-deploy package.full.json version
- [ ] Build and deploy to rmendes.net
- [ ] Verify: admin dashboard shows connection status
- [ ] Verify: polling starts and collects items from Bluesky/Mastodon
- [ ] Verify: `/conversations/api/mentions` returns JF2 data
- [ ] Verify: `/interactions/` inbound tab shows merged data with platform icons
- [ ] Verify: per-post webmentions show enriched data

---

## Deduplication Strategy

When the frontend merges data from both APIs, the same interaction might appear twice (e.g., a Mastodon reply arrives via both webmention.io/Bridgy AND direct API polling).

**Frontend dedup rules:**
1. Build a Set of seen identifiers
2. For webmention-io items: key = `wm-{wm-id}`
3. For conversations items: key = `conv-{platform_id}`
4. Additionally match by `url` field — if two items have the same source URL, keep the one with richer data (conversations item has `platform` field)
5. Conversations items take priority when duplicated (they have platform attribution)

---

## Migration Notes

- The `conversation_items` collection schema doesn't change — same fields, just a new JF2 API layer on top
- The `conversation_state` collection stays the same (polling cursors)
- No data migration needed — existing items (if any) will be served through the new API
- The admin UI route stays at `/conversations` — just shows different content

---

## Dependencies Between Tasks

```
Task 1 (config) ──→ Task 5 (polling) ──→ Task 7 (cloudron config)
                                    └──→ Task 10 (deploy)
Task 2 (admin views) ──→ Task 8 (locales) ──→ Task 10
Task 3 (JF2 API) ──→ Task 6 (theme merge) ──→ Task 10
Task 4 (Granary) ──→ Task 5 (polling)
Task 9 (package) ──→ Task 10 (deploy)
```

Tasks 1-4 can be worked in parallel. Task 5 depends on 1+4. Task 6 depends on 3. Tasks 7-9 can follow once the core is stable. Task 10 is the final verification.

---

## What We're NOT Doing

- NOT replacing webmention.io — it stays as the primary webmention source
- NOT building a new frontend page — enriched data feeds into existing `/interactions/`
- NOT adding moderation to conversations plugin — moderation stays in webmention-io plugin
- NOT changing the webmention-io plugin at all
- NOT adding reply/response capability (sending replies from admin) — out of scope
