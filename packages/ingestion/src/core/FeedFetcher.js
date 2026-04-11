// connext-ingestion/src/core/FeedFetcher.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP feed fetcher with auth injection, retries, compression, and size limits
// ─────────────────────────────────────────────────────────────────────────────

import { request } from "undici";
import { INGESTION_CONFIG } from "../../config/systems.js";

export class FeedFetcher {
  constructor(logger) {
    this.logger = logger.child({ component: "fetcher" });
    this.config = INGESTION_CONFIG;
  }

  /**
   * Fetch a GTFS-RT feed URL and return raw protobuf bytes.
   * Handles auth injection, retries, timeouts, and compression.
   *
   * @param {string} url - Feed URL
   * @param {object} auth - Auth config from system config
   * @returns {Buffer} - Raw protobuf bytes
   */
  async fetchFeed(url, auth = {}) {
    let lastError;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const fetchUrl = this._injectAuth(url, auth);
        const headers = this._buildHeaders(auth);

        const { statusCode, headers: respHeaders, body } = await request(fetchUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
          maxRedirections: 3,
	  autoSelectFamily: true,
        });

        if (statusCode === 429) {
          // Rate limited — back off and retry
          const retryAfter = parseInt(respHeaders["retry-after"] || "5") * 1000;
          this.logger.warn({ url, attempt, retryAfter }, "Rate limited, backing off");
          lastError = new Error(`HTTP 429 (rate limited) from ${url}`);
          await this._sleep(retryAfter);
          continue;
        }

        if (statusCode === 404) {
          // Some agencies occasionally 404 during feed regeneration
          this.logger.warn({ url, attempt }, "Feed returned 404, retrying");
          lastError = new Error(`HTTP 404 from ${url}`);
          await this._sleep(this.config.retryDelayMs);
          continue;
        }

        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`HTTP ${statusCode} from ${url}`);
        }

        // Read the response body as a buffer
        const chunks = [];
        let totalSize = 0;

        for await (const chunk of body) {
          totalSize += chunk.length;
          if (totalSize > this.config.maxFeedSizeBytes) {
            throw new Error(`Feed exceeds max size (${this.config.maxFeedSizeBytes} bytes): ${url}`);
          }
          chunks.push(chunk);
        }

	let buffer = Buffer.concat(chunks);

	if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
		const { gunzipSync } = await import("zlib");
		buffer = gunzipSync(buffer);
	}

        return buffer;

      } catch (err) {
        lastError = err;
        if (attempt < this.config.maxRetries) {
          this.logger.debug({ url, attempt, err: err.message }, "Fetch failed, retrying");
          await this._sleep(this.config.retryDelayMs * attempt);
        }
      }
    }

    throw lastError;
  }

  /**
   * Inject auth into the URL as a query parameter (for systems that use query auth)
   */
  _injectAuth(url, auth) {
    if (auth.type !== "query") return url;

    const apiKey = process.env[auth.envVar];
    if (!apiKey) {
      this.logger.warn(`Missing env var ${auth.envVar} for query auth`);
      return url;
    }

    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}${auth.queryParam}=${apiKey}`;
  }

  /**
   * Build HTTP headers including auth headers and accept-encoding
   */
  _buildHeaders(auth) {
    const headers = {
      "Accept-Encoding": "identity",
      "User-Agent": "Connext-Ingestion/1.0",
    };

    if (auth.type === "header") {
      const apiKey = process.env[auth.envVar];
      if (apiKey) {
        headers[auth.headerName] = apiKey;
      } else {
        this.logger.warn(`Missing env var ${auth.envVar} for header auth`);
      }
    }

    return headers;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
