/**
 * JF2 format transformer
 * Converts conversation_items into JF2 format matching webmention-io response
 * @module transforms/jf2
 */

/**
 * Map internal interaction types to webmention.io wm-property values
 */
const typeToWmProperty = {
  reply: "in-reply-to",
  like: "like-of",
  repost: "repost-of",
  bookmark: "bookmark-of",
  mention: "mention-of",
};

/**
 * Convert a conversation item document to JF2 entry format
 * Compatible with webmention-io's documentToJf2 output
 * @param {object} item - Conversation item from MongoDB
 * @returns {object} JF2 entry
 */
export function conversationItemToJf2(item) {
  const jf2 = {
    type: "entry",
    "wm-id": `conv-${item.platform_id || item._id}`,
    "wm-property": typeToWmProperty[item.type] || "mention-of",
    "wm-target": item.canonical_url,
    "wm-received": item.received_at || item.updated_at,
    author: {
      type: "card",
      name: item.author?.name || "",
      url: item.author?.url || "",
      photo: item.author?.photo || "",
    },
    url: item.url || "",
    published: item.created_at || item.received_at,
    // Extra fields for platform provenance (not in webmention-io format)
    platform: item.source,
    "platform-id": item.platform_id,
  };

  if (item.content) {
    jf2.content = {};
    // If content looks like HTML (has tags), store as html
    if (typeof item.content === "string" && item.content.includes("<")) {
      jf2.content.html = item.content;
      // Strip tags for plain text
      jf2.content.text = item.content.replace(/<[^>]*>/g, "");
    } else if (typeof item.content === "object") {
      if (item.content.html) jf2.content.html = item.content.html;
      if (item.content.text) jf2.content.text = item.content.text;
    } else {
      jf2.content.text = item.content;
    }
  }

  return jf2;
}

/**
 * Map a wm-property query value to internal type
 * @param {string} wmProperty - wm-property value (e.g., "in-reply-to")
 * @returns {string|null} Internal type or null
 */
export function wmPropertyToType(wmProperty) {
  const map = {
    "in-reply-to": "reply",
    "like-of": "like",
    "repost-of": "repost",
    "bookmark-of": "bookmark",
    "mention-of": "mention",
  };
  return map[wmProperty] || null;
}
