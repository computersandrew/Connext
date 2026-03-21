// packages/ingestion/config/transfer-overrides.js
// ─────────────────────────────────────────────────────────────────────────────
// MANUAL TRANSFER OVERRIDES
//
// These override GTFS transfers.txt with real-world knowledge about
// station layouts, platform positions, and walking times.
//
// Sources: personal experience, station maps, transit forums, MTA/MBTA/SEPTA docs
//
// To add overrides for a new system:
//   1. Add a new key to TRANSFER_OVERRIDES with the system id
//   2. Each entry needs: fromStopId, toStopId, type, fixedTimeSec
//   3. Optionally add: fromRouteId/toRouteId, accessibility, notes, distribution
//   4. Run the ingestion engine — overrides load automatically
// ─────────────────────────────────────────────────────────────────────────────

import { TransferType } from "./TransferEngine.js";

export const TRANSFER_OVERRIDES = {

  // ═══════════════════════════════════════════════════════════════════════════
  //  MTA — New York City Subway
  // ═══════════════════════════════════════════════════════════════════════════
  mta: [
    // ─── Times Sq–42 St (huge complex) ─────────────────────────────────
    {
      fromStopId: "127",   // Times Sq (1/2/3)
      toStopId: "902",     // Times Sq (N/Q/R/W/S)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "1/2/3 to N/Q/R/W — one level down via stairs/escalator at south end",
    },
    {
      fromStopId: "127",   // Times Sq (1/2/3)
      toStopId: "725",     // Times Sq (7)
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 300,
      distribution: { mean: 300, stddev: 90 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "1/2/3 to 7 — long underground corridor, multiple levels",
    },
    {
      fromStopId: "902",   // Times Sq (N/Q/R/W)
      toStopId: "725",     // Times Sq (7)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "N/Q/R/W to 7 — stairway connection at mezzanine level",
    },
    {
      fromStopId: "127",   // Times Sq (1/2/3)
      toStopId: "A27",     // 42 St–Port Authority (A/C/E)
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 420,
      distribution: { mean: 420, stddev: 120 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "1/2/3 to A/C/E — long underground passageway to Port Authority",
    },

    // ─── 14 St–Union Sq ────────────────────────────────────────────────
    {
      fromStopId: "635",   // 14 St–Union Sq (4/5/6)
      toStopId: "635",     // Same stop, express/local
      fromRouteId: "6",
      toRouteId: "4",
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 30,
      accessibility: { stairs: false, elevator: false, escalator: false, level: true },
      notes: "6 local to 4/5 express — cross-platform same level",
    },
    {
      fromStopId: "635",   // 14 St–Union Sq (4/5/6)
      toStopId: "L03",     // 14 St–Union Sq (L)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "4/5/6 to L — downstairs to lower level",
    },
    {
      fromStopId: "635",   // 14 St–Union Sq (4/5/6)
      toStopId: "R20",     // 14 St–Union Sq (N/Q/R/W)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 150,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "4/5/6 to N/Q/R/W — mezzanine connection",
    },

    // ─── Atlantic Av–Barclays Ctr ──────────────────────────────────────
    {
      fromStopId: "235",   // Atlantic Av (2/3)
      toStopId: "636",     // Atlantic Av (4/5)
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 30,
      accessibility: { stairs: false, elevator: false, escalator: false, level: true },
      notes: "2/3 to 4/5 — cross-platform, same level",
    },
    {
      fromStopId: "235",   // Atlantic Av (2/3/4/5)
      toStopId: "B12",     // Atlantic Av (B/Q)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 240,
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "IRT to Brighton line — long escalator connection",
    },
    {
      fromStopId: "235",   // Atlantic Av (IRT)
      toStopId: "D24",     // Atlantic Av (D/N/R)
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 300,
      distribution: { mean: 300, stddev: 80 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "IRT to BMT 4th Ave — through mezzanine, can be crowded",
    },

    // ─── Fulton St complex ─────────────────────────────────────────────
    {
      fromStopId: "A40",   // Fulton St (A/C)
      toStopId: "229",     // Fulton St (2/3)
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 240,
      distribution: { mean: 240, stddev: 70 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "Fulton Center — modern transfer hub, multiple levels",
    },
    {
      fromStopId: "229",   // Fulton St (2/3)
      toStopId: "418",     // Fulton St (4/5)
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 30,
      accessibility: { stairs: false, elevator: false, escalator: false, level: true },
      notes: "2/3 to 4/5 — cross-platform",
    },
    {
      fromStopId: "A40",   // Fulton St (A/C)
      toStopId: "M22",     // Fulton St (J/Z)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "A/C to J/Z — corridor through Fulton Center",
    },

    // ─── Grand Central–42 St ───────────────────────────────────────────
    {
      fromStopId: "631",   // Grand Central (4/5/6)
      toStopId: "631",
      fromRouteId: "6",
      toRouteId: "4",
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 30,
      accessibility: { stairs: false, elevator: false, escalator: false, level: true },
      notes: "6 local to 4/5 express — cross-platform",
    },
    {
      fromStopId: "631",   // Grand Central (4/5/6)
      toStopId: "725",     // Grand Central (7)
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 300,
      distribution: { mean: 300, stddev: 90 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "IRT to Flushing 7 — deep underground, long walk",
    },

    // ─── 34 St–Herald Sq ───────────────────────────────────────────────
    {
      fromStopId: "D17",   // Herald Sq (B/D/F/M)
      toStopId: "R17",     // Herald Sq (N/Q/R/W)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 150,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "B/D/F/M to N/Q/R/W — one level via stairs",
    },

    // ─── Jay St–MetroTech ──────────────────────────────────────────────
    {
      fromStopId: "A41",   // Jay St (A/C/F)
      toStopId: "R28",     // Jay St (R)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "A/C/F to R — connected at mezzanine level",
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  //  MBTA — Boston
  // ═══════════════════════════════════════════════════════════════════════════
  mbta: [
    // ─── Park Street ───────────────────────────────────────────────────
    {
      fromStopId: "place-pktrm",
      toStopId: "place-pktrm",
      fromRouteId: "Red",
      toRouteId: "Green-B",
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "Red to Green — up one level via stairs/escalator",
    },
    {
      fromStopId: "place-pktrm",
      toStopId: "place-pktrm",
      fromRouteId: "Green-B",
      toRouteId: "Green-C",
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 30,
      accessibility: { stairs: false, elevator: false, escalator: false, level: true },
      notes: "Green B to Green C/D/E — same platform",
    },

    // ─── Downtown Crossing ─────────────────────────────────────────────
    {
      fromStopId: "place-dwnxg",
      toStopId: "place-dwnxg",
      fromRouteId: "Red",
      toRouteId: "Orange",
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "Red to Orange — mezzanine connection",
    },
    {
      fromStopId: "place-dwnxg",  // Downtown Crossing (Red/Orange)
      toStopId: "place-pktrm",    // Park Street (Green)
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 300,
      distribution: { mean: 300, stddev: 80 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "Downtown Crossing to Park Street — underground walkway (Winter St concourse)",
    },

    // ─── State / Government Center ─────────────────────────────────────
    {
      fromStopId: "place-state",
      toStopId: "place-state",
      fromRouteId: "Orange",
      toRouteId: "Blue",
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "Orange to Blue at State — long corridor",
    },
    {
      fromStopId: "place-gover",
      toStopId: "place-gover",
      fromRouteId: "Blue",
      toRouteId: "Green-B",
      type: TransferType.SAME_STATION,
      fixedTimeSec: 240,
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "Blue to Green at Government Center — renovated headhouse",
    },

    // ─── South Station ─────────────────────────────────────────────────
    {
      fromStopId: "place-sstat",
      toStopId: "place-sstat",
      fromRouteId: "Red",
      toRouteId: "CR-Fairmount",
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 360,
      distribution: { mean: 360, stddev: 100 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "Red Line to Commuter Rail — up to street level, through main hall",
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  //  SEPTA — Philadelphia
  // ═══════════════════════════════════════════════════════════════════════════
  septa: [
    // ─── City Hall ─────────────────────────────────────────────────────
    {
      fromStopId: "BSL_city_hall",  // Broad Street Line
      toStopId: "MFL_city_hall",    // Market-Frankford Line
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "BSL to MFL at City Hall — concourse connection",
    },

    // ─── 15th St / City Hall ───────────────────────────────────────────
    {
      fromStopId: "BSL_city_hall",
      toStopId: "trolley_15th",     // Trolley lines
      type: TransferType.SAME_STATION,
      fixedTimeSec: 240,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "BSL to trolley tunnel — lower concourse level",
    },

    // ─── 30th St Station ───────────────────────────────────────────────
    {
      fromStopId: "MFL_30th",       // MFL subway
      toStopId: "RR_30th",          // Regional Rail
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 360,
      distribution: { mean: 360, stddev: 100 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "MFL to Regional Rail at 30th St — up to main hall, find platform",
    },
    {
      fromStopId: "trolley_30th",   // Trolley
      toStopId: "RR_30th",          // Regional Rail
      type: TransferType.STATION_COMPLEX,
      fixedTimeSec: 420,
      distribution: { mean: 420, stddev: 110 },
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "Trolley portal to 30th St main hall — street level crossing required",
    },

    // ─── Suburban Station ──────────────────────────────────────────────
    {
      fromStopId: "BSL_walnut",     // Walnut-Locust BSL
      toStopId: "RR_suburban",      // Suburban Station
      type: TransferType.STREET_WALK,
      fixedTimeSec: 480,
      distribution: { mean: 480, stddev: 120 },
      accessibility: { stairs: true, elevator: false, escalator: false, level: false },
      notes: "Walnut-Locust BSL to Suburban Station — 2 block walk on Broad St",
    },

    // ─── Jefferson Station ─────────────────────────────────────────────
    {
      fromStopId: "MFL_jefferson",  // MFL
      toStopId: "RR_jefferson",     // Regional Rail
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: true, level: false },
      notes: "MFL to Regional Rail at Jefferson — shared concourse",
    },

    // ─── 69th St Terminal ──────────────────────────────────────────────
    {
      fromStopId: "MFL_69th",       // MFL terminus
      toStopId: "trolley_69th",     // Trolley lines (101, 102)
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: false, elevator: true, escalator: false, level: true },
      notes: "MFL to trolleys — same terminal building, level transfer",
    },
    {
      fromStopId: "MFL_69th",
      toStopId: "NHSL_69th",        // Norristown High Speed Line
      type: TransferType.SAME_STATION,
      fixedTimeSec: 120,
      accessibility: { stairs: false, elevator: true, escalator: false, level: true },
      notes: "MFL to NHSL — adjacent platforms in same terminal",
    },
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  //  CTA — Chicago (ready for when API key arrives)
  // ═══════════════════════════════════════════════════════════════════════════
  cta: [
    // ─── Clark/Lake (Loop hub) ─────────────────────────────────────────
    {
      fromStopId: "40380",   // Clark/Lake (Blue/Brown/Green/Orange/Purple/Pink)
      toStopId: "40380",
      fromRouteId: "Blue",
      toRouteId: "Brown",
      type: TransferType.SAME_STATION,
      fixedTimeSec: 180,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "Blue to elevated lines — subway to elevated level",
    },

    // ─── Belmont ───────────────────────────────────────────────────────
    {
      fromStopId: "40660",   // Belmont (Brown/Red/Purple)
      toStopId: "40660",
      fromRouteId: "Red",
      toRouteId: "Brown",
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 60,
      accessibility: { stairs: false, elevator: true, escalator: false, level: true },
      notes: "Red to Brown/Purple — island platform shared",
    },

    // ─── Roosevelt ─────────────────────────────────────────────────────
    {
      fromStopId: "41400",   // Roosevelt (Red/Orange/Green)
      toStopId: "41400",
      fromRouteId: "Red",
      toRouteId: "Green",
      type: TransferType.SAME_STATION,
      fixedTimeSec: 240,
      accessibility: { stairs: true, elevator: true, escalator: false, level: false },
      notes: "Red (subway) to Green/Orange (elevated) — significant level change",
    },

    // ─── Fullerton ─────────────────────────────────────────────────────
    {
      fromStopId: "41220",   // Fullerton (Red/Brown/Purple)
      toStopId: "41220",
      fromRouteId: "Red",
      toRouteId: "Brown",
      type: TransferType.SAME_PLATFORM,
      fixedTimeSec: 60,
      accessibility: { stairs: false, elevator: true, escalator: false, level: true },
      notes: "Red to Brown/Purple — shared island platform",
    },
  ],
};
