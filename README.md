# conneXt

Modular transit wayfinder app with real-time GTFS data, connection probability engine, and platform-aware transfers.

**Last updated: March 21, 2026**

---

## Project Status

| Component | Status | Details |
|-----------|--------|---------|
| **Ingestion Engine** | ✅ Running | MTA, MBTA, SEPTA live. CTA pending API key. |
| **API Server** | ✅ Running | REST + WebSocket, 11 endpoints |
| **Transfer Engine** | ✅ Loaded | 36 manual overrides across 4 systems |
| **React Native App** | ⏳ Planned | — |
| **Production Deploy** | ⏳ Planned | french slander |

### Transit Systems

| System | City | Ingestion | Data Source | Notes |
|--------|------|-----------|-------------|-------|
| **MTA** | New York City | ✅ Live | GTFS-RT protobuf (7/8 feeds working) | SIR feed returns XML, skipped gracefully |
| **MBTA** | Boston | ✅ Live | GTFS-RT protobuf | All feeds working |
| **CTA** | Chicago | ⏳ Pending | GTFS-RT protobuf | Waiting on API key approval |
| **SEPTA** | Philadelphia | ✅ Live | Hybrid: JSON APIs (primary) + GTFS-RT (fallback) | TrainView, TransitView, Arrivals, Alerts |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          React Native App                                │
│                    (iOS + Android — planned)                              │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTPS / WebSocket
┌───────────────────────────────▼──────────────────────────────────────────┐
│                          API Server (Fastify)                            │
│  REST: alerts, departures, route planner, transfers, health              │
│  WS:   live alert stream, departure countdown                            │
│  Transfer Engine: platform-aware probability calculations                │
├──────────────────────────────────────────────────────────────────────────┤
│                          Redis (real-time cache)                         │
│  departures:{system}:{stop}  vehicles:{system}:{route}  alerts:{system} │
├──────────────────────────────────────────────────────────────────────────┤
│                       Ingestion Engine (Node.js)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │   MTA    │ │   MBTA   │ │   CTA    │ │  SEPTA   │  ← Adapter plugins│
│  │ protobuf │ │ protobuf │ │ protobuf │ │ JSON+pb  │                    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                   │
│  BaseAdapter · FeedFetcher · Orchestrator · protobuf utils              │
├──────────────────────────────────────────────────────────────────────────┤
│                     PostgreSQL (static GTFS + history)                   │
│  gtfs_routes · gtfs_stops · gtfs_trips · gtfs_transfers · delay_history │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js 20+ (`node --version`)
- Docker + Docker Compose (`docker --version`)
- Git (`git --version`)

### 1. Clone and install

```bash
git clone git@github.com:YOUR_USERNAME/connext.git
cd connext
```

### 2. Start infrastructure

```bash
docker compose up -d
# Verify: docker compose ps (should show redis + postgres healthy)
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
# Fill in your API keys (MTA needs none, SEPTA needs none)
```

### 4. Start the ingestion engine (Terminal 1)

```bash
cd packages/ingestion
npm install
set -a && source ../../.env && set +a
npm start
```

### 5. Start the API server (Terminal 2)

```bash
cd packages/api
npm install
set -a && source ../../.env && set +a
npm start
```

### 6. Test

```bash
# Health
curl http://localhost:3000/api/v1/health

# Systems
curl http://localhost:3000/api/v1/systems

# Alerts
curl http://localhost:3000/api/v1/alerts/septa

# Departures (list stops first, then query a specific one)
curl http://localhost:3000/api/v1/departures/septa
curl http://localhost:3000/api/v1/departures/septa/STOP_ID

# Transfer info
curl "http://localhost:3000/api/v1/transfer/mta/127/725"

# Route planner
curl "http://localhost:3000/api/v1/plan/septa?from=STOP_ID&to=STOP_ID"

# WebSocket (install wscat: npm install -g wscat)
wscat -c ws://localhost:3000/ws/alerts
wscat -c ws://localhost:3000/ws/departures/septa/STOP_ID
```

---

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | System health, Redis status, key counts per system |
| GET | `/api/v1/health/:system` | Health for a specific system |
| GET | `/api/v1/systems` | List all supported systems with live status |
| GET | `/api/v1/alerts` | All active alerts across all systems |
| GET | `/api/v1/alerts/:system` | Alerts for a specific system |
| GET | `/api/v1/alerts/:system/:route` | Alerts for a specific route |
| GET | `/api/v1/departures/:system` | List all stops with departure data |
| GET | `/api/v1/departures/:system/:stop` | Next departures at a stop (with countdown) |
| GET | `/api/v1/plan/:system?from=X&to=Y` | Route planner with transfer probability |
| GET | `/api/v1/transfer/:system/:from/:to` | Transfer detail between two stops |
| GET | `/api/v1/transfers/:system/stats` | Transfer engine statistics |

### Query Parameters

| Endpoint | Param | Description |
|----------|-------|-------------|
| `/departures` | `limit` | Max results (default: 10) |
| `/departures` | `route` | Filter by route ID or name |
| `/plan` | `from` | Origin stop ID (required) |
| `/plan` | `to` | Destination stop ID (required) |
| `/plan` | `depart` | Departure time HH:MM (default: now) |
| `/plan` | `pace` | Walking pace: slow, average, fast (default: average) |
| `/transfer` | `fromRoute` | Filter by origin route |
| `/transfer` | `toRoute` | Filter by destination route |

### WebSocket Endpoints

| Endpoint | Description | Client Messages |
|----------|-------------|-----------------|
| `WS /ws/alerts` | Live alert stream (pushes every 10s) | `{"systems": ["mta","septa"]}` to filter |
| `WS /ws/departures/:system/:stop` | Live countdown (pushes every 5s) | `{"route": "A"}` to filter by route |

---

## Adding a New Transit System

This is designed to be a ~15 minute task. You need three things: feed URLs, auth info, and route colors.

### Step 1: Find the agency's data

Go to one of these to find your agency's GTFS-RT feeds:

- [transitfeeds.com](https://transitfeeds.com) — global catalog of GTFS feeds
- [transit.land/feeds](https://www.transit.land/feeds) — Transitland feed registry
- The agency's developer portal (search "[agency name] developer API")

You need to find:

| Info | What to look for | Example |
|------|------------------|---------|
| GTFS-RT feed URLs | TripUpdates, VehiclePositions, Alerts endpoints | `https://cdn.mbta.com/realtime/TripUpdates.pb` |
| Auth method | API key in header, query param, or none | Header: `x-api-key`, Query: `?key=XXX`, or none |
| Static GTFS URL | A .zip file with routes.txt, stops.txt, etc. | `https://cdn.mbta.com/MBTA_GTFS.zip` |
| Route map | Line names and colors | Agency website or Wikipedia |

Some agencies also have proprietary JSON APIs that may have better coverage than their GTFS-RT feeds (like SEPTA). Check for these too — you can build a hybrid adapter.

### Step 2: Scaffold the adapter

```bash
cd packages/ingestion
npm run add-system -- --id wmata --name "WMATA" --city "Washington DC"
```

This creates `src/adapters/wmata.js` from a template and prints the config entry to add to `config/systems.js`.

### Step 3: Add the config entry

Open `packages/ingestion/config/systems.js` and add the entry the scaffold script printed. It looks like this:

```javascript
wmata: {
  id: "wmata",
  name: "WMATA",
  city: "Washington DC",
  region: { lat: 38.9072, lng: -77.0369, radiusKm: 30 },
  enabled: true,
  adapter: "wmata",
  feeds: {
    tripUpdates: ["https://api.wmata.com/gtfs/rail-gtfsrt-tripupdates.pb"],
    vehiclePositions: ["https://api.wmata.com/gtfs/rail-gtfsrt-vehiclepositions.pb"],
    alerts: ["https://api.wmata.com/gtfs/rail-gtfsrt-alerts.pb"],
  },
  auth: {
    type: "header",
    headerName: "api_key",
    envVar: "WMATA_API_KEY",
  },
  intervals: {
    tripUpdates: 15000,
    vehiclePositions: 30000,
    alerts: 60000,
  },
  staticGtfs: {
    url: "https://developer.wmata.com/gtfs/WMATA-GTFS-Current.zip",
    refreshDays: 14,
  },
},
```

Fill in the real feed URLs, auth type, and coordinates for your system.

### Step 4: Edit the adapter — route mapping

Open `src/adapters/wmata.js` and fill in the `_resolveRoute()` method. This maps route IDs from the feed to human-readable names and colors:

```javascript
_resolveRoute(routeId) {
  const routes = {
    "RED":    { name: "Red Line",    color: "#BF0D3E", type: "subway" },
    "ORANGE": { name: "Orange Line", color: "#ED8B00", type: "subway" },
    "SILVER": { name: "Silver Line", color: "#A2A4A1", type: "subway" },
    "BLUE":   { name: "Blue Line",   color: "#009CDE", type: "subway" },
    "YELLOW": { name: "Yellow Line", color: "#FFD100", type: "subway" },
    "GREEN":  { name: "Green Line",  color: "#00B140", type: "subway" },
  };
  return routes[routeId] || { name: routeId || "?", color: "#888888", type: "other" };
}
```

Get line names and colors from the agency's system map, Wikipedia, or the static GTFS `routes.txt` file (fields: `route_short_name`, `route_color`).

### Step 5: Handle system-specific quirks (if any)

Most agencies work out of the box with the standard GTFS-RT parser. But some have quirks:

| Quirk | Example | How to handle |
|-------|---------|---------------|
| Feed returns XML/HTML sometimes | MTA SIR feed | Already handled — bad buffers are skipped |
| Multi-feed split by line group | MTA (9 separate feeds) | List all URLs in the `feeds.tripUpdates` array |
| Proprietary JSON API instead of GTFS-RT | SEPTA | Override `onStart()` to add custom JSON polling loops (see `septa.js`) |
| Custom protobuf extensions | MTA NYCT | Already handled — `.proto` file loader skips unknown fields |
| Direction conventions | MTA uses N/S suffix on stop_id | Override `_normalizeTripUpdates()` to parse direction |
| No API key required | MTA, SEPTA | Set `auth: { type: "none" }` |

If the feed uses standard GTFS-RT with no quirks, the scaffolded adapter works without any changes to `parseFeed()` or `normalize()`.

### Step 6: Add transfer overrides (optional but recommended)

Open `packages/ingestion/config/transfer-overrides.js` and add a section for your system. Research the major transfer stations:

```javascript
wmata: [
  {
    fromStopId: "C01",    // Metro Center
    toStopId: "C01",
    fromRouteId: "RED",
    toRouteId: "ORANGE",
    type: TransferType.SAME_PLATFORM,
    fixedTimeSec: 60,
    accessibility: { stairs: false, elevator: true, escalator: false, level: true },
    notes: "Red to Orange/Silver/Blue — cross-platform transfer",
  },
  // ... more transfers
],
```

Transfer type reference:

| Type | Time range | Example |
|------|-----------|---------|
| `SAME_PLATFORM` | 0-1 min | Express/local on same track, cross-platform |
| `SAME_STATION` | 1-4 min | Different platform, stairs/elevator within station |
| `STATION_COMPLEX` | 3-8 min | Underground walkway between connected stations |
| `STREET_WALK` | 5-15 min | Exit station, walk to a nearby station |

### Step 7: Set API key and validate

```bash
# Add to .env
echo 'WMATA_API_KEY=your-key-here' >> ../../.env

# Validate adapter structure
npm run validate

# Source env and start
set -a && source ../../.env && set +a
npm start
```

Watch the logs — you should see the new system start polling and data flowing into Redis.

### Step 8: Add to API config

Open `packages/api/src/config.js` and add the system:

```javascript
export const SYSTEMS = {
  // ... existing systems
  wmata: { id: "wmata", name: "WMATA", city: "Washington DC" },
};
```

Also copy your transfer overrides to the API's shared directory:

```bash
cp packages/ingestion/config/transfer-overrides.js packages/api/src-shared/
```

Restart the API server and test:

```bash
curl http://localhost:3000/api/v1/health/wmata
curl http://localhost:3000/api/v1/departures/wmata
curl http://localhost:3000/api/v1/alerts/wmata
```

### Step 9: Commit

```bash
git add -A
git commit -m "ingestion: add WMATA adapter (Washington DC)

- WMATA Metro GTFS-RT feeds (trip updates, vehicle positions, alerts)
- Route color mapping for all 6 metro lines
- Transfer overrides for Metro Center, Gallery Place, L'Enfant Plaza
- API config updated"

git push
```

---

## Monorepo Structure

```
connext/
├── packages/
│   ├── ingestion/                 ← GTFS-RT feed processing
│   │   ├── config/
│   │   │   ├── systems.js         ← System registry (feed URLs, auth, intervals)
│   │   │   └── transfer-overrides.js ← Manual platform/transfer data
│   │   ├── src/
│   │   │   ├── index.js           ← Entry point
│   │   │   ├── core/
│   │   │   │   ├── BaseAdapter.js ← Adapter contract + lifecycle
│   │   │   │   ├── FeedFetcher.js ← HTTP + auth + retries
│   │   │   │   ├── Orchestrator.js ← Plugin discovery + health
│   │   │   │   └── TransferEngine.js ← Platform-aware transfer model
│   │   │   ├── adapters/
│   │   │   │   ├── mta.js         ← NYC MTA (protobuf, 9 feeds)
│   │   │   │   ├── mbta.js        ← Boston MBTA (protobuf)
│   │   │   │   ├── cta.js         ← Chicago CTA (protobuf)
│   │   │   │   └── septa.js       ← Philadelphia SEPTA (hybrid JSON+protobuf)
│   │   │   └── utils/
│   │   │       ├── protobuf.js    ← GTFS-RT decoding (.proto file loader)
│   │   │       └── route-lookup.js ← Static GTFS data cache
│   │   ├── scripts/
│   │   │   ├── scaffold-adapter.js ← Generate new adapter from template
│   │   │   └── validate-adapters.js ← Check all adapters are valid
│   │   └── gtfs-realtime.proto    ← GTFS-RT proto definition
│   │
│   ├── api/                       ← REST + WebSocket API
│   │   ├── src/
│   │   │   ├── index.js           ← Fastify server entry point
│   │   │   ├── config.js          ← Port, Redis, system list
│   │   │   ├── redis.js           ← Redis client + helpers
│   │   │   ├── routes/
│   │   │   │   ├── alerts.js      ← Alert endpoints
│   │   │   │   ├── departures.js  ← Departure endpoints + WS countdown
│   │   │   │   ├── health.js      ← Health + system list endpoints
│   │   │   │   └── planner.js     ← Route planner + transfer probability
│   │   │   └── ws/
│   │   │       └── alerts.js      ← WebSocket alert stream
│   │   └── src-shared/
│   │       ├── TransferEngine.js  ← Shared with ingestion
│   │       └── transfer-overrides.js
│   │
│   └── app/                       ← React Native app (planned)
│
├── infrastructure/
│   └── db/
│       ├── init.sql               ← Base schema (routes, stops, trips, delay_history)
│       └── 002_transfers.sql      ← Transfers, pathways, levels tables
│
├── docker-compose.yml             ← Redis + PostgreSQL for dev
├── .env.example                   ← Environment variable template
└── README.md                      ← This file
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MTA_API_KEY` | No | — | Not required (MTA dropped key requirement) |
| `MBTA_API_KEY` | Yes (for MBTA) | — | Register at api-v3.mbta.com |
| `CTA_API_KEY` | Yes (for CTA) | — | Register at transitchicago.com/developers |
| `REDIS_HOST` | No | 127.0.0.1 | Redis host |
| `REDIS_PORT` | No | 6379 | Redis port |
| `PG_HOST` | No | 127.0.0.1 | PostgreSQL host |
| `PG_PORT` | No | 5432 | PostgreSQL port |
| `PG_DATABASE` | No | connext | PostgreSQL database |
| `PG_USER` | No | connext | PostgreSQL user |
| `PG_PASSWORD` | No | connext | PostgreSQL password |
| `API_PORT` | No | 3000 | API server port |
| `LOG_LEVEL` | No | info | Pino log level |

## License

Private — not yet open source.
