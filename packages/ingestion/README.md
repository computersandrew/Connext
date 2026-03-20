# Connext Ingestion Engine

Modular GTFS-RT feed ingestion system for the Connext transit app. Each transit system is a self-contained adapter plugin.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator                          │
│  Discovers adapters · Manages lifecycle · Health API     │
├─────────────┬──────────────┬──────────────┬─────────────┤
│  MTA        │  MBTA        │  CTA         │  SEPTA      │  ← Adapters
│  Adapter    │  Adapter     │  Adapter     │  Adapter    │     (plugins)
├─────────────┴──────────────┴──────────────┴─────────────┤
│              BaseAdapter (contract)                       │
│  parseFeed() · normalize() · writeToCache()              │
├──────────────────────┬──────────────────────────────────┤
│    FeedFetcher       │     Protobuf Utils               │
│  HTTP · Auth · Retry │  Decode · Extract · Translate    │
├──────────────────────┴──────────────────────────────────┤
│  Redis (RT cache)         │  PostgreSQL (static GTFS)   │
└───────────────────────────┴─────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Set API keys (get free keys from each agency)
export MTA_API_KEY="your-mta-key"
export MBTA_API_KEY="your-mbta-key"
export CTA_API_KEY="your-cta-key"
# SEPTA requires no key

# Start Redis and PostgreSQL (Docker example)
docker run -d --name connext-redis -p 6379:6379 redis:alpine
docker run -d --name connext-pg -p 5432:5432 \
  -e POSTGRES_DB=connext -e POSTGRES_USER=connext -e POSTGRES_PASSWORD=connext \
  postgres:16-alpine

# Validate all adapters
npm run validate

# Start the ingestion engine
npm start

# Health check
curl http://localhost:9090/health
```

## Adding a New Transit System

This is designed to be a 10-minute task:

```bash
# 1. Scaffold the adapter
npm run add-system -- --id wmata --name "WMATA" --city "Washington DC"

# 2. Edit the generated files:
#    - src/adapters/wmata.js → fill in _resolveRoute() with line colors
#    - config/systems.js → add the config entry (printed by the scaffold script)

# 3. Set any API key env vars
export WMATA_API_KEY="your-key"

# 4. Validate
npm run validate

# 5. Start
npm start
```

### What You Need to Know About a New System

| Info needed | Where to find it |
|---|---|
| GTFS-RT feed URLs | Agency developer portal or transitfeeds.com |
| Auth method | Usually documented on the developer portal |
| Route ID → name/color mapping | Static GTFS routes.txt or agency maps |
| Stop ID format quirks | Compare static GTFS stops.txt with RT feed stop_ids |
| Direction conventions | Check trip headsigns in static GTFS |

### Adapter Contract

Every adapter must implement two methods:

```javascript
// Parse raw protobuf buffer into entities
parseFeed(feedType, buffer) → Array<object>

// Transform entities into Connext's normalized format
normalize(feedType, entities) → Array<NormalizedObject>
```

The `BaseAdapter` handles everything else: polling, retries, caching, error tracking.

## Project Structure

```
connext-ingestion/
├── config/
│   └── systems.js          # System registry + global config
├── src/
│   ├── index.js             # Entry point
│   ├── core/
│   │   ├── BaseAdapter.js   # Adapter contract + lifecycle
│   │   ├── FeedFetcher.js   # HTTP + auth + retries
│   │   └── Orchestrator.js  # Plugin loader + health
│   ├── adapters/
│   │   ├── mta.js           # NYC MTA
│   │   ├── mbta.js          # Boston MBTA
│   │   ├── cta.js           # Chicago CTA
│   │   └── septa.js         # Philadelphia SEPTA
│   └── utils/
│       ├── protobuf.js      # GTFS-RT parsing helpers
│       └── route-lookup.js  # Static GTFS data cache
├── scripts/
│   ├── scaffold-adapter.js  # Generate new adapter template
│   └── validate-adapters.js # Check all adapters are valid
└── tests/
```

## Redis Key Structure

```
connext:departures:{system}:{stop_id}     → JSON array of upcoming departures
connext:departures:{system}:_summary      → { count, updatedAt }
connext:vehicles:{system}:{route_id}      → JSON array of vehicle positions
connext:alerts:{system}                   → JSON array of active alerts
```

## Health API

```
GET /health   → Full system status (all adapters, stats, errors)
GET /adapters → List of registered adapter IDs
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MTA_API_KEY` | Yes (for MTA) | MTA developer API key |
| `MBTA_API_KEY` | Yes (for MBTA) | MBTA V3 API key |
| `CTA_API_KEY` | Yes (for CTA) | CTA developer API key |
| `REDIS_HOST` | No (default: 127.0.0.1) | Redis host |
| `REDIS_PORT` | No (default: 6379) | Redis port |
| `REDIS_PASSWORD` | No | Redis password |
| `PG_HOST` | No (default: 127.0.0.1) | PostgreSQL host |
| `PG_PORT` | No (default: 5432) | PostgreSQL port |
| `PG_DATABASE` | No (default: connext) | PostgreSQL database |
| `PG_USER` | No (default: connext) | PostgreSQL user |
| `PG_PASSWORD` | No (default: connext) | PostgreSQL password |
| `LOG_LEVEL` | No (default: info) | Pino log level |
