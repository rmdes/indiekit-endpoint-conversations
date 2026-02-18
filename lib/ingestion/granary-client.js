/**
 * Granary REST API client
 * Optional format conversion between ActivityStreams/microformats2/AT Protocol
 * Uses the Granary REST API: https://granary.io/
 * @module ingestion/granary-client
 */

/**
 * Convert content between formats using Granary REST API
 * @param {string} url - URL of the content to convert
 * @param {object} options - Conversion options
 * @param {string} options.input - Input format (activitystreams, html, atom, jsonfeed)
 * @param {string} options.output - Output format (html, activitystreams, atom, jsonfeed, mf2-json)
 * @param {string} [options.granaryUrl] - Custom Granary instance URL
 * @returns {Promise<string>} Converted content
 */
export async function convert(url, options) {
  const {
    input = "html",
    output = "mf2-json",
    granaryUrl = "https://granary.io",
  } = options;

  const apiUrl = new URL("/url", granaryUrl);
  apiUrl.searchParams.set("input", input);
  apiUrl.searchParams.set("output", output);
  apiUrl.searchParams.set("url", url);

  const response = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "IndieKit-Conversations/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Granary API ${response.status}: ${response.statusText}`,
    );
  }

  if (output === "mf2-json" || output === "activitystreams") {
    return response.json();
  }

  return response.text();
}
