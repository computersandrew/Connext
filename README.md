# conneXt

Modular transit wayfinder app with real-time GTFS data, connection probability engine, and platform-aware transfers.

**Last updated: March 23, 2026**

---

## Project Status

| Component | Status | Details |
|-----------|--------|---------|
| **Ingestion Engine** | ✅ Running | All 4 systems live |
| **API Server** | ✅ Running | 14 REST endpoints + 2 WebSocket streams |
| **Route Planner** | ✅ Working | Graph-based pathfinding with real travel times |
| **Transfer Engine** | ✅ Working | 36 manual overrides + 2,958 GTFS transfers, cross-platform resolution |
| **React Native App** | ✅ Working | Expo, iOS via Expo Go |
| **Production Deploy** | ⏳ Planned | *insert le french revolution |

### Transit Systems

| System | City | Ingestion | Route Graph | Data Source |
|--------|------|-----------|-------------|-------------|
| **MTA** | New York City | ✅ Live | 2,053 edges, 956 stops | GTFS-RT protobuf (8 feeds) |
| **MBTA** | Boston | ✅ Live | 11,703 edges, 7,299 stops | GTFS-RT protobuf |
| **CTA** | Chicago | ✅ Live | 14,304 edges, 10,945 stops | Train Tracker JSON API (hybrid) |
| **SEPTA** | Philadelphia | ✅ Live | 440 edges, 156 stops | JSON APIs + GTFS-RT (hybrid) |

### Data Pipeline

| Dataset | Rows | Description |
|---------|------|-------------|
| **stop_times** | 4,990,440 | Schedule data for route graph |
| **route_graph** | 28,500 edges | Pre-computed stop-to-stop connections with travel times |
| **stop_connections** | 19,356 stops | Reachability index |
| **GTFS stops** | 22,802 | Station names, coordinates, parent relationships |
| **GTFS routes** | 571 | Route names, colors, types |
| **GTFS trips** | 126,291 | Trip-to-route mapping |
| **GTFS transfers** | 2,958 | Official transfer rules |
| **Manual transfers** | 36 | Platform-level overrides for major stations |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     React Native App (Expo)                              │
│  Onboarding → "Where to?" → Route cards / Live departures               │
│  Location-aware system detection · Real-time ticking countdown           │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTPS / WebSocket
┌───────────────────────────────▼──────────────────────────────────────────┐
│                        API Server (Fastify)                              │
│  Route planner (graph-based) · Departures · Alerts · Transfers          │
│  Parent station resolution · Cross-platform transfer matching            │
├──────────────────────────────────────────────────────────────────────────┤
│                 Redis (real-time cache)        PostgreSQL (static GTFS)  │
│  departures · vehicles · alerts               route_graph · stop_times  │
│  45s TTL · 13,000+ live keys                  stops · routes · transfers│
├──────────────────────────────────────────────────────────────────────────┤
│                       Ingestion Engine (Node.js)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │   MTA    │ │   MBTA   │ │   CTA    │ │  SEPTA   │                   │
│  │ protobuf │ │ protobuf │ │ JSON API │ │ JSON+pb  │                   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                   │
│  BaseAdapter · FeedFetcher · Orchestrator · TransferEngine              │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- Git

### 1. Clone and install

```bash
git clone git@github.com:YOUR_USERNAME/connext.git
cd connext
```

### 2. Start infrastructure

```bash
docker compose up -d
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
# Fill in API keys (MTA and SEPTA need none)
```

### 4. Import GTFS data

```bash
cd packages/ingestion
npm install
set -a && source ../../.env && set +a

# Import routes, stops, trips, transfers
npm run import-gtfs

# Import stop_times and build route graph (takes ~2 minutes)
npm run import-stop-times
```

### 5. Start the ingestion engine (Terminal 1)

```bash
cd packages/ingestion
set -a && source ../../.env && set +a
npm start
```

### 6. Start the API server (Terminal 2)

```bash
cd packages/api
npm install
set -a && source ../../.env && set +a
npm start
```

### 7. Start the mobile app (Terminal 3)

```bash
cd packages/app
npm install
npx expo start
# Scan QR code with iPhone (Expo Go required)
```

### 8. Test the API

```bash
# Health
curl http://localhost:3000/api/v1/health

# Search stations by name
curl "http://localhost:3000/api/v1/stops/mbta/search?q=park"

# Live departures
curl "http://localhost:3000/api/v1/departures/mbta/place-gover"

# Route planner (direct route)
curl "http://localhost:3000/api/v1/plan/mbta?from=place-pktrm&to=place-gover"

# Route planner (with transfer)
curl "http://localhost:3000/api/v1/plan/mbta?from=place-rbmnl&to=place-rugg"

# Transfer info
curl "http://localhost:3000/api/v1/transfer/mta/127/725"
```

---

## Route Planner

The route planner uses a pre-computed graph from GTFS stop_times data to find routes between any two stations.

### How it works

1. **Resolve stop IDs** — parent station IDs expand to all child platform stop IDs
2. **Find direct routes** — check if any route serves both origin and destination
3. **Find transfer routes** — find stops where route A and route B share a parent station (cross-platform transfers)
4. **Calculate travel times** — actual times from stop_times data, not estimates
5. **Calculate transfer probability** — uses TransferEngine with platform type, rush hour, and walking pace

### Transfer types

| Type | Time | Example |
|------|------|---------|
| Same platform | ~0 min | Express/local cross-platform |
| Same station | 1-4 min | Stairs/elevator between platforms |
| Station complex | 3-8 min | Underground walkway |
| Street walk | 5-15 min | Exit and walk to nearby station |

### Cross-platform resolution

The planner resolves transfers through parent stations. For example, at MBTA State Street:
- Blue Line platforms: `70041`, `70042`
- Orange Line platforms: `70022`, `70023`
- Parent station: `place-state`

The planner knows these are all "State" and routes through them as transfer points.

---

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | System health, Redis status |
| GET | `/api/v1/health/:system` | Per-system health |
| GET | `/api/v1/systems` | List supported systems |
| GET | `/api/v1/alerts` | All active alerts |
| GET | `/api/v1/alerts/:system` | Alerts for a system |
| GET | `/api/v1/alerts/:system/:route` | Alerts for a route |
| GET | `/api/v1/departures/:system` | List stops with data |
| GET | `/api/v1/departures/:system/:stop` | Departures at a stop |
| GET | `/api/v1/stops/:system/search?q=X` | Search stations by name |
| GET | `/api/v1/stops/:system` | List all stations |
| GET | `/api/v1/plan/:system?from=X&to=Y` | Route planner |
| GET | `/api/v1/transfer/:system/:from/:to` | Transfer detail |
| GET | `/api/v1/transfers/:system/stats` | Transfer engine stats |

### WebSocket Endpoints

| Endpoint | Description |
|----------|-------------|
| `WS /ws/alerts` | Live alert stream (10s push) |
| `WS /ws/departures/:system/:stop` | Live countdown (5s push) |

### Planner Query Parameters

| Param | Description |
|-------|-------------|
| `from` | Origin stop ID (required) |
| `to` | Destination stop ID (required) |
| `pace` | Walking pace: slow, average, fast |
| `depart` | Departure time HH:MM |

---

## Adding a New Transit System

### Step 1: Find feed URLs

Check [transitfeeds.com](https://transitfeeds.com) or the agency's developer portal for GTFS-RT feeds and static GTFS zip.

### Step 2: Scaffold

```bash
cd packages/ingestion
npm run add-system -- --id wmata --name "WMATA" --city "Washington DC"
```

### Step 3: Configure

Add the system entry to `config/systems.js` with feed URLs, auth type, and coordinates.

### Step 4: Edit the adapter

Fill in `_resolveRoute()` with line names and colors. Handle any agency-specific quirks (split feeds, JSON APIs, non-standard stop IDs).

### Step 5: Import GTFS data

```bash
npm run import-gtfs -- --system wmata
npm run import-stop-times -- --system wmata
```

### Step 6: Add to API config

Add the system to `packages/api/src/config.js` and optionally add manual transfer overrides.

### Step 7: Test and commit

```bash
npm run validate
npm start
# Verify data flows, then commit
```

---

## Monorepo Structure

```
connext/
├── packages/
│   ├── ingestion/                     ← GTFS-RT feed processing
│   │   ├── config/
│   │   │   ├── systems.js             ← System registry
│   │   │   └── transfer-overrides.js  ← Manual platform data
│   │   ├── src/
│   │   │   ├── core/
│   │   │   │   ├── BaseAdapter.js     ← Adapter contract
│   │   │   │   ├── FeedFetcher.js     ← HTTP + auth + retries
│   │   │   │   ├── Orchestrator.js    ← Plugin discovery
│   │   │   │   └── TransferEngine.js  ← Probability model
│   │   │   ├── adapters/
│   │   │   │   ├── mta.js             ← NYC (protobuf, 8 feeds)
│   │   │   │   ├── mbta.js            ← Boston (protobuf)
│   │   │   │   ├── cta.js             ← Chicago (Train Tracker JSON)
│   │   │   │   └── septa.js           ← Philadelphia (hybrid JSON+protobuf)
│   │   │   └── utils/
│   │   │       ├── protobuf.js        ← GTFS-RT decoding
│   │   │       └── route-lookup.js    ← Static GTFS cache
│   │   └── scripts/
│   │       ├── import-gtfs.js         ← Routes, stops, trips, transfers
│   │       ├── import-stop-times.js   ← Stop times + route graph builder
│   │       ├── scaffold-adapter.js    ← New system generator
│   │       └── validate-adapters.js   ← Adapter validation
│   │
│   ├── api/                           ← REST + WebSocket API
│   │   ├── src/
│   │   │   ├── index.js               ← Fastify server
│   │   │   ├── routes/
│   │   │   │   ├── alerts.js          ← Alert endpoints
│   │   │   │   ├── departures.js      ← Departures + parent station resolution
│   │   │   │   ├── health.js          ← Health + systems
│   │   │   │   ├── planner.js         ← Route planner (graph-based)
│   │   │   │   └── stops.js           ← Station name search
│   │   │   └── ws/
│   │   │       └── alerts.js          ← WebSocket alert stream
│   │   └── src-shared/
│   │       ├── TransferEngine.js
│   │       └── transfer-overrides.js
│   │
│   └── app/                           ← React Native (Expo)
│       ├── App.js                     ← Onboarding + entry
│       └── src/
│           ├── screens/
│           │   ├── HomeScreen.js      ← "Where to?" + station search
│           │   ├── ResultsScreen.js   ← Route cards / live departures
│           │   ├── DeparturesScreen.js ← Full departure board
│           │   └── SettingsScreen.js
│           ├── services/
│           │   ├── api.js             ← REST + WebSocket client
│           │   └── location.js        ← GPS + system detection
│           ├── navigation/
│           │   └── index.js
│           └── theme/
│               └── index.js           ← Softer dark theme
│
├── infrastructure/
│   └── db/
│       ├── init.sql                   ← Base schema
│       ├── 002_transfers.sql          ← Transfers, pathways, levels
│       └── 003_stop_times.sql         ← Stop times + route graph views
│
├── docker-compose.yml                 ← Redis + PostgreSQL
├── .env.example
└── README.md
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MBTA_API_KEY` | Yes (for MBTA) | Register at api-v3.mbta.com |
| `CTA_API_KEY` | Yes (for CTA) | Register at transitchicago.com/developers |
| `REDIS_HOST` | No (default: 127.0.0.1) | Redis host |
| `REDIS_PORT` | No (default: 6379) | Redis port |
| `PG_HOST` | No (default: 127.0.0.1) | PostgreSQL host |
| `PG_PORT` | No (default: 5432) | PostgreSQL port |
| `PG_DATABASE` | No (default: connext) | PostgreSQL database |
| `PG_USER` | No (default: connext) | PostgreSQL user |
| `PG_PASSWORD` | No (default: connext) | PostgreSQL password |
| `API_PORT` | No (default: 3000) | API server port |
| `LOG_LEVEL` | No (default: info) | Log level |

MTA and SEPTA require no API keys.

## License

Private — not yet open source.
