/**
 * Conversation items storage
 * MongoDB CRUD for conversation items with deduplication
 * @module storage/conversation-items
 */

/**
 * Get the conversation_items collection
 * @param {object} application - Indiekit application
 * @returns {object} MongoDB collection
 */
function getCollection(application) {
  return application.collections.get("conversation_items");
}

/**
 * Upsert a conversation item (insert or update, dedup by platform_id)
 * @param {object} application - Indiekit application
 * @param {object} item - Conversation item data
 * @returns {Promise<object>} Upserted item
 */
export async function upsertConversationItem(application, item) {
  const collection = getCollection(application);

  const result = await collection.findOneAndUpdate(
    {
      canonical_url: item.canonical_url,
      platform_id: item.platform_id,
    },
    {
      $set: {
        ...item,
        updated_at: new Date().toISOString(),
      },
      $setOnInsert: {
        received_at: new Date().toISOString(),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
    },
  );

  return result;
}

/**
 * Get conversation items for a canonical URL
 * @param {object} application - Indiekit application
 * @param {string} canonicalUrl - The canonical post URL
 * @param {object} [options] - Query options
 * @param {string} [options.source] - Filter by source protocol
 * @param {string} [options.type] - Filter by interaction type
 * @param {number} [options.limit] - Max items to return
 * @returns {Promise<Array>} Array of conversation items
 */
export async function getConversationItems(
  application,
  canonicalUrl,
  options = {},
) {
  const collection = getCollection(application);
  const query = {};

  if (canonicalUrl) query.canonical_url = canonicalUrl;
  if (options.source) query.source = options.source;
  if (options.type) query.type = options.type;

  let cursor = collection.find(query).sort({ received_at: -1 });

  if (options.skip) cursor = cursor.skip(options.skip);
  cursor = cursor.limit(options.limit || 100);

  return cursor.toArray();
}

/**
 * Get conversation summaries (posts with interaction counts)
 * @param {object} application - Indiekit application
 * @param {object} [options] - Query options
 * @param {number} [options.limit] - Max posts to return
 * @param {number} [options.skip] - Number of posts to skip
 * @returns {Promise<Array>} Array of post summaries with counts
 */
export async function getConversationSummaries(application, options = {}) {
  const collection = getCollection(application);

  return collection
    .aggregate([
      {
        $group: {
          _id: "$canonical_url",
          total: { $sum: 1 },
          replies: {
            $sum: { $cond: [{ $eq: ["$type", "reply"] }, 1, 0] },
          },
          likes: {
            $sum: { $cond: [{ $eq: ["$type", "like"] }, 1, 0] },
          },
          reposts: {
            $sum: { $cond: [{ $eq: ["$type", "repost"] }, 1, 0] },
          },
          mentions: {
            $sum: { $cond: [{ $eq: ["$type", "mention"] }, 1, 0] },
          },
          sources: { $addToSet: "$source" },
          last_activity: { $max: "$received_at" },
        },
      },
      { $sort: { last_activity: -1 } },
      { $skip: options.skip || 0 },
      { $limit: options.limit || 50 },
    ])
    .toArray();
}

/**
 * Get total count of conversation items
 * @param {object} application - Indiekit application
 * @returns {Promise<number>} Total count
 */
export async function getConversationCount(application) {
  const collection = getCollection(application);
  return collection.countDocuments();
}

/**
 * Delete conversation items for a canonical URL
 * @param {object} application - Indiekit application
 * @param {string} canonicalUrl - The canonical post URL
 * @returns {Promise<number>} Number of deleted items
 */
export async function deleteConversationItems(application, canonicalUrl) {
  const collection = getCollection(application);
  const result = await collection.deleteMany({ canonical_url: canonicalUrl });
  return result.deletedCount;
}

/**
 * Create MongoDB indexes for conversation_items
 * @param {object} application - Indiekit application
 */
export async function createIndexes(application) {
  const collection = getCollection(application);

  await collection.createIndex(
    { canonical_url: 1, platform_id: 1 },
    { unique: true, name: "dedup_index" },
  );

  await collection.createIndex(
    { canonical_url: 1, received_at: -1 },
    { name: "conversation_thread" },
  );

  await collection.createIndex(
    { source: 1, received_at: -1 },
    { name: "source_filter" },
  );

}
