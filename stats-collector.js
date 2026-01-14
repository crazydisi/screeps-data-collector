const https = require('https');
const net = require('net');
const zlib = require('zlib');

// =============================================================================
// Configuration
// =============================================================================

const config = {
  // Screeps API
  token: process.env.SCREEPS_TOKEN,
  host: process.env.SCREEPS_HOST || 'screeps.com',

  // Shards to monitor (comma-separated, or 'all' for auto-discovery)
  shards: (process.env.SCREEPS_SHARDS || 'shard3').split(',').map(s => s.trim()),
  autoDiscoverShards: process.env.SCREEPS_SHARDS === 'all',

  // Stats source: 'memory' (Memory.stats) or 'segment' (Memory segment)
  statsSource: process.env.STATS_SOURCE || 'memory',
  statsPath: process.env.STATS_PATH || 'stats',
  statsSegment: parseInt(process.env.STATS_SEGMENT) || 30,

  // Graphite
  graphiteHost: process.env.GRAPHITE_HOST || 'screeps-graphite',
  graphitePort: parseInt(process.env.GRAPHITE_PORT) || 2003,

  // Collector settings
  minPollInterval: parseInt(process.env.MIN_POLL_INTERVAL) || 60000,
  prefix: process.env.METRICS_PREFIX || 'screeps',
  includeShard: process.env.INCLUDE_SHARD_IN_PATH !== 'false',

  // Retry settings
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 5000
};

// State
let availableShards = [];
let activeShards = new Set(); // Shards that have returned data
let rateLimitedUntil = 0;
let consecutiveErrors = 0;
let lastShardCheck = 0;
const SHARD_CHECK_INTERVAL = 5 * 60 * 1000; // Re-check inactive shards every 5 minutes

// Rate limit tracking (per-endpoint)
const rateLimitInfo = {
  limit: 1440,        // Default daily limit for /api/user/memory
  remaining: 1440,
  reset: 0,           // UTC epoch seconds when limit resets
  lastUpdated: 0
};

// Dynamic poll interval
let dynamicPollInterval = config.minPollInterval;

// =============================================================================
// API Functions
// =============================================================================

/**
 * Update rate limit info from response headers
 */
function updateRateLimitInfo(headers) {
  const limit = parseInt(headers['x-ratelimit-limit']);
  const remaining = parseInt(headers['x-ratelimit-remaining']);
  const reset = parseInt(headers['x-ratelimit-reset']);

  if (!isNaN(limit)) rateLimitInfo.limit = limit;
  if (!isNaN(remaining)) rateLimitInfo.remaining = remaining;
  if (!isNaN(reset)) rateLimitInfo.reset = reset;
  rateLimitInfo.lastUpdated = Date.now();

  // Recalculate optimal poll interval
  recalculatePollInterval();
}

/**
 * Calculate optimal poll interval based on remaining quota and active shards
 */
function recalculatePollInterval() {
  const now = Math.floor(Date.now() / 1000);
  const secondsUntilReset = Math.max(0, rateLimitInfo.reset - now);
  const activeShardCount = Math.max(1, activeShards.size);

  if (rateLimitInfo.remaining <= 0) {
    // No requests left, wait until reset
    dynamicPollInterval = (secondsUntilReset + 60) * 1000;
    console.log(`[Rate Limit] No requests remaining, waiting ${Math.ceil(dynamicPollInterval / 1000)}s until reset`);
    return;
  }

  if (secondsUntilReset <= 0) {
    // Reset time passed, use default interval
    dynamicPollInterval = config.minPollInterval;
    return;
  }

  // Calculate: how often can we poll given remaining requests and time until reset?
  // Leave 10% buffer for safety
  const safeRemaining = Math.floor(rateLimitInfo.remaining * 0.9);
  const requestsPerPoll = activeShardCount; // One request per active shard
  const pollsWeCanMake = Math.floor(safeRemaining / requestsPerPoll);

  if (pollsWeCanMake <= 0) {
    // Not enough requests left, wait until reset
    dynamicPollInterval = (secondsUntilReset + 60) * 1000;
    console.log(`[Rate Limit] Low quota (${rateLimitInfo.remaining}), waiting ${Math.ceil(dynamicPollInterval / 1000)}s`);
    return;
  }

  // Spread polls evenly across remaining time
  const calculatedInterval = Math.ceil((secondsUntilReset * 1000) / pollsWeCanMake);

  // Clamp between minimum (30s) and maximum (5 min)
  const minInterval = 30000;
  const maxInterval = 300000;
  dynamicPollInterval = Math.max(minInterval, Math.min(maxInterval, calculatedInterval));

  // Don't go below configured interval
  dynamicPollInterval = Math.max(dynamicPollInterval, config.minPollInterval);

  console.log(`[Rate Limit] ${rateLimitInfo.remaining}/${rateLimitInfo.limit} remaining, reset in ${secondsUntilReset}s, interval: ${Math.ceil(dynamicPollInterval / 1000)}s`);
}

/**
 * Make an HTTPS request to the Screeps API
 */
function apiRequest(path, retries = 0) {
  return new Promise((resolve, reject) => {
    // Check rate limit
    if (Date.now() < rateLimitedUntil) {
      const waitTime = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
      reject(new Error(`Rate limited, retry in ${waitTime}s`));
      return;
    }

    const options = {
      hostname: config.host,
      path: path,
      headers: { 'X-Token': config.token }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Update rate limit info from headers
        updateRateLimitInfo(res.headers);

        // Check for rate limiting
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after']) || 60;
          rateLimitedUntil = Date.now() + (retryAfter * 1000);
          reject(new Error(`Rate limited for ${retryAfter}s`));
          return;
        }

        try {
          const json = JSON.parse(data);

          if (!json.ok) {
            reject(new Error(json.error || 'API error'));
            return;
          }

          consecutiveErrors = 0;
          resolve(json);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    }).on('error', (e) => {
      // Retry logic with exponential backoff
      if (retries < config.maxRetries) {
        const delay = config.retryDelay * Math.pow(2, retries);
        console.log(`Request failed, retrying in ${delay}ms... (${retries + 1}/${config.maxRetries})`);
        setTimeout(() => {
          apiRequest(path, retries + 1).then(resolve).catch(reject);
        }, delay);
      } else {
        consecutiveErrors++;
        reject(new Error(`Fetch error after ${config.maxRetries} retries: ${e.message}`));
      }
    });
  });
}

/**
 * Discover available shards from the API
 */
async function discoverShards() {
  try {
    const response = await apiRequest('/api/game/shards/info');
    if (response.shards && Array.isArray(response.shards)) {
      availableShards = response.shards.map(s => s.name);
      console.log(`Discovered shards: ${availableShards.join(', ')}`);
    }
  } catch (e) {
    console.error('Failed to discover shards:', e.message);
    // Fall back to default shards
    availableShards = ['shard0', 'shard1', 'shard2', 'shard3'];
  }
}

/**
 * Decode memory data (handles gzip compression)
 */
function decodeMemoryData(data) {
  if (!data) return null;

  if (data.startsWith('gz:')) {
    const compressed = Buffer.from(data.slice(3), 'base64');
    return JSON.parse(zlib.gunzipSync(compressed).toString());
  }

  return JSON.parse(data);
}

/**
 * Fetch stats from Memory.stats path
 */
async function fetchMemoryStats(shard) {
  const response = await apiRequest(`/api/user/memory?path=${config.statsPath}&shard=${shard}`);

  if (!response.data) {
    return null;
  }

  return decodeMemoryData(response.data);
}

/**
 * Fetch stats from a memory segment
 */
async function fetchSegmentStats(shard) {
  const response = await apiRequest(`/api/user/memory-segment?segment=${config.statsSegment}&shard=${shard}`);

  if (!response.data) {
    return null;
  }

  return decodeMemoryData(response.data);
}

/**
 * Fetch stats using configured method
 */
async function fetchStats(shard) {
  if (config.statsSource === 'segment') {
    return fetchSegmentStats(shard);
  }
  return fetchMemoryStats(shard);
}

// =============================================================================
// Graphite Functions
// =============================================================================

/**
 * Flatten nested object into Graphite metric lines
 */
function flattenToMetrics(obj, prefix, timestamp) {
  const lines = [];

  function flatten(o, p) {
    for (const [k, v] of Object.entries(o)) {
      // Sanitize key (replace invalid characters)
      const sanitizedKey = k.replace(/[^a-zA-Z0-9_-]/g, '_');
      const key = `${p}.${sanitizedKey}`;

      if (typeof v === 'number' && isFinite(v)) {
        lines.push(`${key} ${v} ${timestamp}`);
      } else if (typeof v === 'boolean') {
        lines.push(`${key} ${v ? 1 : 0} ${timestamp}`);
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        flatten(v, key);
      }
    }
  }

  flatten(obj, prefix);
  return lines;
}

/**
 * Send metrics to Graphite
 */
function sendToGraphite(lines) {
  return new Promise((resolve, reject) => {
    if (lines.length === 0) {
      resolve(0);
      return;
    }

    const client = new net.Socket();
    let resolved = false;

    client.setTimeout(10000);

    client.connect(config.graphitePort, config.graphiteHost, () => {
      client.write(lines.join('\n') + '\n');
      client.end();
    });

    client.on('close', () => {
      if (!resolved) {
        resolved = true;
        resolve(lines.length);
      }
    });

    client.on('timeout', () => {
      client.destroy();
      if (!resolved) {
        resolved = true;
        reject(new Error('Graphite connection timeout'));
      }
    });

    client.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Graphite error: ${e.message}`));
      }
    });
  });
}

// =============================================================================
// Main Collection Loop
// =============================================================================

/**
 * Collect stats from all configured shards
 * Uses smart detection: only polls shards that have returned data,
 * periodically re-checks inactive shards for new activity
 */
async function collectStats() {
  const timestamp = Math.floor(Date.now() / 1000);
  const allShards = config.autoDiscoverShards ? availableShards : config.shards;
  let totalMetrics = 0;

  // Determine which shards to check this cycle
  const now = Date.now();
  const shouldCheckInactive = (now - lastShardCheck) >= SHARD_CHECK_INTERVAL;

  if (shouldCheckInactive) {
    lastShardCheck = now;
  }

  // If we have active shards, only poll those (plus inactive check periodically)
  // If no active shards yet, poll all to discover
  const shardsToCollect = activeShards.size > 0 && !shouldCheckInactive
    ? allShards.filter(s => activeShards.has(s))
    : allShards;

  if (shouldCheckInactive && activeShards.size > 0) {
    console.log(`[${new Date().toISOString()}] Checking all shards for new activity...`);
  }

  for (const shard of shardsToCollect) {
    try {
      const stats = await fetchStats(shard);

      if (!stats) {
        // Only log if this was an active shard that stopped returning data
        if (activeShards.has(shard)) {
          console.log(`[${shard}] No longer returning stats, marking inactive`);
          activeShards.delete(shard);
        } else if (shouldCheckInactive || activeShards.size === 0) {
          // Only log during full checks, not every cycle
          console.log(`[${shard}] No stats data`);
        }
        continue;
      }

      // Mark shard as active if it returned data
      if (!activeShards.has(shard)) {
        console.log(`[${shard}] Detected stats data, marking active`);
        activeShards.add(shard);
      }

      // Build prefix with or without shard
      const prefix = config.includeShard
        ? `${config.prefix}.${shard}`
        : config.prefix;

      const lines = flattenToMetrics(stats, prefix, timestamp);
      const sent = await sendToGraphite(lines);

      console.log(`[${new Date().toISOString()}] [${shard}] Sent ${sent} metrics`);
      totalMetrics += sent;

    } catch (e) {
      console.error(`[${shard}] Error:`, e.message);
    }
  }

  if (totalMetrics > 0) {
    const activeCount = activeShards.size;
    console.log(`[${new Date().toISOString()}] Total: ${totalMetrics} metrics from ${activeCount} active shard(s)`);
  }
}

/**
 * Main collection loop with error handling
 * Schedules next run based on dynamic poll interval
 */
async function runCollector() {
  try {
    await collectStats();
  } catch (e) {
    console.error('Collection error:', e.message);
  }

  // Schedule next collection with dynamic interval
  const nextInterval = dynamicPollInterval;
  setTimeout(runCollector, nextInterval);
  console.log(`[${new Date().toISOString()}] Next collection in ${Math.ceil(nextInterval / 1000)}s`);
}

// =============================================================================
// Startup
// =============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('Screeps Data Collector');
  console.log('='.repeat(60));
  console.log(`Host:          ${config.host}`);
  console.log(`Shards:        ${config.autoDiscoverShards ? 'auto-discover' : config.shards.join(', ')}`);
  console.log(`Auto-scaling:  enabled (checks inactive shards every 5 min)`);
  console.log(`Rate limiting: dynamic (adjusts based on API quota)`);
  console.log(`Stats source:  ${config.statsSource}${config.statsSource === 'segment' ? ` (segment ${config.statsSegment})` : ` (${config.statsPath})`}`);
  console.log(`Min interval:  ${config.minPollInterval}ms`);
  console.log(`Graphite:      ${config.graphiteHost}:${config.graphitePort}`);
  console.log(`Prefix:        ${config.prefix}`);
  console.log(`Include shard: ${config.includeShard}`);
  console.log('='.repeat(60));

  // Validate token
  if (!config.token) {
    console.error('ERROR: SCREEPS_TOKEN environment variable is required');
    process.exit(1);
  }

  // Discover shards if needed
  if (config.autoDiscoverShards) {
    await discoverShards();
  }

  // Start collection loop (self-scheduling with dynamic interval)
  await runCollector();
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});

// Start
main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
