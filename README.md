# connext

Modular transit wayfinder app with real-time GTFS data and connection probability engine.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `packages/ingestion` | GTFS-RT feed ingestion engine | 🚧 Building |
| `packages/api` | REST/WebSocket API server | ⏳ Planned |
| `packages/app` | React Native mobile app | ⏳ Planned |
| `infrastructure` | Docker, nginx, deployment | ⏳ Planned |

## Supported Transit Systems

- **MTA** — New York City subway/bus
- **MBTA** — Boston subway/light rail
- **CTA** — Chicago rail
- **SEPTA** — Philadelphia subway/trolley/regional rail

## Quick Start
```bash
# Start dependencies
docker compose up -d

# Install and run ingestion
cd packages/ingestion
npm install
npm start
```

## Adding a New Transit System
```bash
cd packages/ingestion
npm run add-system -- --id wmata --name WMATA --city "Washington DC"
# Then edit the generated adapter and config entry
```
