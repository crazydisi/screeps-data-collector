# Screeps Data Collector

A complete, self-hosted monitoring stack for the Screeps game. Includes a Node.js data collector, Graphite time-series database, and Grafana dashboards.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/crazydisi/screeps-data-collector.git
cd screeps-data-collector

# Copy and configure environment
cp .env.example .env
# Edit .env and set SCREEPS_TOKEN

# Start the stack
docker-compose up -d
```

Grafana will be available at `http://localhost:3000` (or your configured URL).

## Repository Structure

```text
screeps-data-collector/
├── stats-collector.js      # Data collector script
├── docker-compose.yml      # Complete monitoring stack
├── .env.example            # Configuration template
├── dashboards/
│   └── general-overview.json   # Pre-built Grafana dashboard
└── README.md
```

## Features

- **Multi-shard support** - Monitor one, multiple, or all shards simultaneously
- **Auto-discovery** - Automatically detect available shards
- **Multiple data sources** - Read from `Memory.stats` or memory segments
- **Private server support** - Works with self-hosted Screeps servers
- **Rate limit handling** - Automatic detection and backoff when rate limited
- **Retry logic** - Exponential backoff for failed requests
- **Graceful shutdown** - Proper signal handling for container environments
- **Zero dependencies** - Uses only Node.js built-in modules

## Architecture

```text
┌─────────────────┐     ┌──────────────────┐     ┌───────────┐     ┌─────────┐
│   Screeps API   │────▶│  Data Collector  │────▶│  Graphite │────▶│ Grafana │
│  (Memory.stats) │     │   (this repo)    │     │ (storage) │     │  (UI)   │
└─────────────────┘     └──────────────────┘     └───────────┘     └─────────┘
        │                        │
        │                        ├── Multi-shard polling
        │                        ├── Memory or Segment source
        │                        ├── Rate limit detection
        │                        └── Retry with backoff
        │
        └── shard0, shard1, shard2, shard3
```

The collector:

1. Polls the Screeps API at a configurable interval (default: 60 seconds)
2. Reads stats from `Memory.stats` or a memory segment
3. Supports multiple shards in a single collector instance
4. Flattens nested objects into Graphite-compatible metric paths
5. Handles rate limits gracefully with automatic backoff
6. Sends metrics via TCP to Graphite on port 2003

## Requirements

- Node.js 18+ (or use the Docker setup)
- A Screeps API token from [screeps.com](https://screeps.com/a/#!/account/auth-tokens)
- A running Graphite instance

## Configuration

The collector is configured via environment variables:

### Required

| Variable        | Description                 |
| --------------- | --------------------------- |
| `SCREEPS_TOKEN` | Your Screeps API auth token |

### Screeps API

| Variable        | Default       | Description                                           |
| --------------- | ------------- | ----------------------------------------------------- |
| `SCREEPS_HOST`  | `screeps.com` | Screeps server hostname (for private servers)         |
| `SCREEPS_SHARDS`| `shard3`      | Comma-separated shards, or `all` for auto-discovery   |

### Stats Source

| Variable        | Default   | Description                                       |
| --------------- | --------- | ------------------------------------------------- |
| `STATS_SOURCE`  | `memory`  | Source type: `memory` or `segment`                |
| `STATS_PATH`    | `stats`   | Memory path when using `memory` source            |
| `STATS_SEGMENT` | `30`      | Segment ID when using `segment` source            |

### Graphite

| Variable         | Default           | Description                      |
| ---------------- | ----------------- | -------------------------------- |
| `GRAPHITE_HOST`  | `screeps-graphite`| Graphite server hostname         |
| `GRAPHITE_PORT`  | `2003`            | Graphite plaintext protocol port |

### Collector Behavior

| Variable                | Default   | Description                        |
| ----------------------- | --------- | ---------------------------------- |
| `POLL_INTERVAL`         | `60000`   | Polling interval in milliseconds   |
| `METRICS_PREFIX`        | `screeps` | Prefix for all metric paths        |
| `INCLUDE_SHARD_IN_PATH` | `true`    | Include shard name in metric path  |
| `MAX_RETRIES`           | `3`       | Max retries for failed requests    |
| `RETRY_DELAY`           | `5000`    | Base delay for retry backoff (ms)  |

## Usage

### Standalone

```bash
export SCREEPS_TOKEN=your-token-here
export GRAPHITE_HOST=localhost
node stats-collector.js
```

### Multi-Shard Example

```bash
export SCREEPS_TOKEN=your-token-here
export SCREEPS_SHARDS=shard0,shard1,shard2,shard3
node stats-collector.js
```

### Auto-Discover All Shards

```bash
export SCREEPS_TOKEN=your-token-here
export SCREEPS_SHARDS=all
node stats-collector.js
```

### Using Memory Segments

```bash
export SCREEPS_TOKEN=your-token-here
export STATS_SOURCE=segment
export STATS_SEGMENT=30
node stats-collector.js
```

### With Docker Compose

This repository includes a complete Docker Compose stack with Graphite and Grafana:

```bash
cp .env.example .env
# Edit .env and set SCREEPS_TOKEN
docker-compose up -d
```

The stack includes:

- **screeps-stats**: Data collector container
- **screeps-graphite**: Time-series database
- **screeps-grafana**: Dashboard UI (with Traefik integration)

## Dashboard Setup

After starting the stack, configure Grafana to display your Screeps metrics:

### 1. Add Graphite Data Source

1. Open Grafana at `http://localhost:3000` (default login: admin/admin)
2. Go to **Connections** → **Data sources** → **Add data source**
3. Select **Graphite**
4. Configure:
   - **Name**: `Graphite` (or any name you prefer)
   - **URL**: `http://screeps-graphite:80`
5. Click **Save & test** to verify the connection

### 2. Import the Dashboard

1. Go to **Dashboards** → **New** → **Import**
2. Upload the JSON file from `dashboards/general-overview.json` in this repository
3. Select your Graphite data source when prompted
4. Click **Import**

The dashboard will start showing data once metrics have been collected (may take a few minutes after initial setup).

## Memory.stats Format

The collector reads from `Memory.stats` (or a segment) in your Screeps code. Any nested object structure will be flattened:

```javascript
// In your Screeps main.js
Memory.stats = {
  cpu: {
    used: Game.cpu.getUsed(),
    bucket: Game.cpu.bucket,
    limit: Game.cpu.limit
  },
  gcl: {
    level: Game.gcl.level,
    progress: Game.gcl.progress
  },
  rooms: {
    W7N7: {
      rcl: room.controller.level,
      energy: room.energyAvailable
    }
  }
};
```

With `INCLUDE_SHARD_IN_PATH=true` (default), this becomes:

```text
screeps.shard3.cpu.used
screeps.shard3.cpu.bucket
screeps.shard3.cpu.limit
screeps.shard3.gcl.level
screeps.shard3.gcl.progress
screeps.shard3.rooms.ROOM_NAME.rcl
screeps.shard3.rooms.ROOM_NAME.energy
```

With `INCLUDE_SHARD_IN_PATH=false`:

```text
screeps.cpu.used
screeps.cpu.bucket
...
```

## Rate Limits

The Screeps API has a rate limit of 60 requests per minute for token-authenticated requests. The collector handles this automatically:

- Detects 429 responses and pauses until the rate limit resets
- Uses exponential backoff for network errors
- Default 60-second polling interval (1 request/minute per shard) stays within limits

For multi-shard setups, consider increasing `POLL_INTERVAL` to avoid hitting limits:

- 1 shard: 60000ms (60s) = 1 req/min
- 4 shards: 60000ms = 4 req/min (safe)
- 4 shards: 15000ms = 16 req/min (safe, but aggressive)

## License

GPL-3.0
