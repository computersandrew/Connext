// packages/api/src/routes/fares.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/fares/:system              — all fare products for a system
// GET /api/v1/fares/:system/route/:route — fare for a specific route
// ─────────────────────────────────────────────────────────────────────────────

import { SYSTEMS } from "../config.js";

// Hardcoded fallback fares for when GTFS fare data is missing or sparse.
// Prices are adult cash / card fares as of early 2025.
// Keys match the agency's GTFS route_type: 0=tram/streetcar, 1=subway, 2=rail, 3=bus
// transfers: null = unlimited free transfers, number = how many free transfers included
// transferDurationSec: how long the transfer window lasts
const FALLBACK_FARES = {
  // MTA NYC: flat $2.90, unlimited free transfers between subway + bus within 2h
  mta:   { price: 2.90, currency: "USD", label: "$2.90", note: "MetroCard/OMNY", transfers: null, transferDurationSec: 7200 },
  // MBTA: fare by mode; subway-to-subway transfers are free within 2h on CharlieCard
  mbta:  {
    byType: {
      0: { price: 2.40, currency: "USD", label: "$2.40", note: "CharlieCard", transfers: null, transferDurationSec: 7200 }, // Green Line
      1: { price: 2.40, currency: "USD", label: "$2.40", note: "CharlieCard", transfers: null, transferDurationSec: 7200 }, // Subway
      2: { price: null, currency: "USD", label: "Zone fare", note: "Varies by zone", transfers: 0, transferDurationSec: null }, // Commuter rail
      3: { price: 1.70, currency: "USD", label: "$1.70", note: "CharlieCard", transfers: 1, transferDurationSec: 7200 }, // Bus (1 free transfer)
    },
    default: { price: 2.40, currency: "USD", label: "$2.40", note: "CharlieCard", transfers: null, transferDurationSec: 7200 },
  },
  // CTA: 2 free transfers within 2h (rail or bus)
  cta:   {
    byType: {
      1: { price: 2.50, currency: "USD", label: "$2.50", note: "Ventra card", transfers: 2, transferDurationSec: 7200 },
      3: { price: 2.25, currency: "USD", label: "$2.25", note: "Ventra card", transfers: 2, transferDurationSec: 7200 },
    },
    default: { price: 2.50, currency: "USD", label: "$2.50", note: "Ventra card", transfers: 2, transferDurationSec: 7200 },
  },
  // SEPTA: no free transfers (each trip charged separately)
  septa: {
    byType: {
      0: { price: 2.00, currency: "USD", label: "$2.00", note: "SEPTA Key", transfers: 0, transferDurationSec: null },
      1: { price: 2.00, currency: "USD", label: "$2.00", note: "SEPTA Key", transfers: 0, transferDurationSec: null },
      2: { price: null, currency: "USD", label: "Zone fare", note: "Varies by zone", transfers: 0, transferDurationSec: null },
      3: { price: 2.00, currency: "USD", label: "$2.00", note: "SEPTA Key", transfers: 0, transferDurationSec: null },
    },
    default: { price: 2.00, currency: "USD", label: "$2.00", note: "SEPTA Key", transfers: 0, transferDurationSec: null },
  },
  cdta:    { price: 1.50, currency: "USD", label: "$1.50", note: "Exact change / CDTA app", transfers: 1, transferDurationSec: 5400 },
  rtd:     { price: 3.00, currency: "USD", label: "$3.00", note: "Local fare", transfers: 0, transferDurationSec: null },
  bustang: { price: 8.00, currency: "USD", label: "$8.00+", note: "Intercity fare", transfers: 0, transferDurationSec: null },
};

// In-memory fare cache per (system, routeId) — populated lazily from DB
const fareCache = new Map();

export default async function fareRoutes(fastify, { pg }) {

  // ── All fares for a system ────────────────────────────────────────────────
  fastify.get("/api/v1/fares/:system", async (req, reply) => {
    const { system } = req.params;
    if (!SYSTEMS[system]) return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });

    if (!pg) {
      // Return fallback only
      return buildFallbackResponse(system);
    }

    try {
      // Try v2 first (fare_products)
      const v2Check = await pg.query(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'gtfs_fare_products'`
      );
      if (parseInt(v2Check.rows[0].count) > 0) {
        const v2Result = await pg.query(`
          SELECT DISTINCT ON (fp.fare_product_id)
            fp.fare_product_id,
            fp.fare_product_name,
            fp.amount,
            fp.currency,
            fp.fare_media_id,
            fm.fare_media_name,
            fm.fare_media_type,
            flr.network_id,
            flr.from_area_id,
            flr.to_area_id
          FROM gtfs_fare_products fp
          LEFT JOIN gtfs_fare_media fm ON fm.system_id = fp.system_id AND fm.fare_media_id = fp.fare_media_id
          LEFT JOIN gtfs_fare_leg_rules flr ON flr.system_id = fp.system_id AND flr.fare_product_id = fp.fare_product_id
            AND (flr.transfer_only IS NULL OR flr.transfer_only = 0)
          WHERE fp.system_id = $1 AND fp.amount > 0
          ORDER BY fp.fare_product_id, fp.amount ASC
        `, [system]);

        if (v2Result.rows.length > 0) {
          return {
            system,
            source: "gtfs_v2",
            fares: v2Result.rows.map((r) => ({
              fareId: r.fare_product_id,
              name: r.fare_product_name,
              price: parseFloat(r.amount),
              currency: r.currency,
              label: formatPrice(parseFloat(r.amount), r.currency),
              paymentMethod: r.fare_media_name || r.fare_media_id || "any",
              mediaType: r.fare_media_type,
              network: r.network_id,
              fromArea: r.from_area_id,
              toArea: r.to_area_id,
              isZoneBased: !!(r.from_area_id || r.to_area_id),
            })),
          };
        }
      }

      // Fall back to v1
      const result = await pg.query(`
        SELECT
          fa.fare_id, fa.price, fa.currency_type, fa.payment_method,
          fa.transfers, fa.transfer_duration,
          ARRAY_AGG(DISTINCT fr.route_id) FILTER (WHERE fr.route_id IS NOT NULL AND fr.route_id != '') AS route_ids
        FROM gtfs_fare_attributes fa
        LEFT JOIN gtfs_fare_rules fr ON fr.system_id = fa.system_id AND fr.fare_id = fa.fare_id
        WHERE fa.system_id = $1
        GROUP BY fa.fare_id, fa.price, fa.currency_type, fa.payment_method, fa.transfers, fa.transfer_duration
        ORDER BY fa.price
      `, [system]);

      if (result.rows.length === 0) {
        return buildFallbackResponse(system);
      }

      return {
        system,
        source: "gtfs_v1",
        fares: result.rows.map((r) => ({
          fareId: r.fare_id,
          price: parseFloat(r.price),
          currency: r.currency_type,
          label: formatPrice(parseFloat(r.price), r.currency_type),
          paymentMethod: r.payment_method === 1 ? "pre-board" : "on-board",
          transfers: r.transfers === null ? "unlimited" : r.transfers,
          transferDurationSec: r.transfer_duration ? parseInt(r.transfer_duration) : null,
          routeIds: r.route_ids || [],
        })),
      };
    } catch (err) {
      fastify.log.warn({ err: err.message }, "Fare DB query failed, using fallback");
      return buildFallbackResponse(system);
    }
  });

  // ── Fare for a specific route ─────────────────────────────────────────────
  fastify.get("/api/v1/fares/:system/route/:routeId", async (req, reply) => {
    const { system, routeId } = req.params;
    if (!SYSTEMS[system]) return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });

    const fare = await getFareForRoute(pg, system, routeId, fastify.log);
    return { system, routeId, fare };
  });
}

// ─── Core fare lookup (used by planner.js too via export) ────────────────────

export async function getFareForRoute(pg, system, routeId, log) {
  const cacheKey = `${system}::${routeId}`;
  if (fareCache.has(cacheKey)) return fareCache.get(cacheKey);

  if (pg) {
    try {
      // ── GTFS Fares v2: look up by network_id (modern agencies like MBTA) ──
      // fare_leg_rules maps network_id → fare_product → price.
      // We pick the cheapest non-transfer-only product for the route's network.
      const v2Res = await pg.query(`
        SELECT fp.amount, fp.currency, fp.fare_product_id, fp.fare_product_name,
               fp.fare_media_id, gr.network_id
        FROM gtfs_routes gr
        JOIN gtfs_fare_leg_rules flr
          ON flr.system_id = gr.system_id
         AND flr.network_id = gr.network_id
         AND (flr.transfer_only IS NULL OR flr.transfer_only = 0)
        JOIN gtfs_fare_products fp
          ON fp.system_id = flr.system_id
         AND fp.fare_product_id = flr.fare_product_id
        WHERE gr.system_id = $1 AND gr.route_id = $2
          AND fp.amount > 0
        ORDER BY fp.amount ASC
        LIMIT 1
      `, [system, routeId]);

      if (v2Res.rows.length > 0) {
        const r = v2Res.rows[0];
        // Determine transfer policy from fare_transfer_rules for this fare product
        const xferRes = await pg.query(`
          SELECT transfer_count, duration_limit
          FROM gtfs_fare_transfer_rules
          WHERE system_id = $1
            AND (filter_fare_product_id = $2 OR fare_product_id = $2)
          LIMIT 1
        `, [system, r.fare_product_id]);
        const xfer = xferRes.rows[0];
        const transfersIncluded = xfer
          ? (xfer.transfer_count === null || xfer.transfer_count === -1 ? null : xfer.transfer_count)
          : null;
        const fare = buildFareObj(parseFloat(r.amount), r.currency, transfersIncluded, xfer?.duration_limit || null, "gtfs_v2");
        fareCache.set(cacheKey, fare);
        return fare;
      }

      // ── GTFS Fares v1: route-specific rule ──────────────────────────────
      const ruleRes = await pg.query(`
        SELECT fa.price, fa.currency_type, fa.transfers, fa.transfer_duration
        FROM gtfs_fare_rules fr
        JOIN gtfs_fare_attributes fa ON fa.system_id = fr.system_id AND fa.fare_id = fr.fare_id
        WHERE fr.system_id = $1 AND fr.route_id = $2
        ORDER BY fa.price ASC
        LIMIT 1
      `, [system, routeId]);

      if (ruleRes.rows.length > 0) {
        const r = ruleRes.rows[0];
        const fare = buildFareObj(parseFloat(r.price), r.currency_type, r.transfers, r.transfer_duration, "gtfs_v1");
        fareCache.set(cacheKey, fare);
        return fare;
      }

      // ── GTFS Fares v1: flat fare ─────────────────────────────────────────
      const flatRes = await pg.query(`
        SELECT fa.price, fa.currency_type, fa.transfers, fa.transfer_duration
        FROM gtfs_fare_attributes fa
        WHERE fa.system_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM gtfs_fare_rules fr
            WHERE fr.system_id = fa.system_id AND fr.fare_id = fa.fare_id AND fr.route_id IS NOT NULL AND fr.route_id != ''
          )
        ORDER BY fa.price ASC
        LIMIT 1
      `, [system]);

      if (flatRes.rows.length > 0) {
        const r = flatRes.rows[0];
        const fare = buildFareObj(parseFloat(r.price), r.currency_type, r.transfers, r.transfer_duration, "gtfs_v1");
        fareCache.set(cacheKey, fare);
        return fare;
      }
    } catch (err) {
      log?.warn({ err: err.message }, "Fare route lookup failed, using fallback");
    }
  }

  // 3. Hardcoded fallback — try to get the route_type to pick the right tier
  let routeType = null;
  if (pg) {
    try {
      const rtRes = await pg.query(
        `SELECT route_type FROM gtfs_routes WHERE system_id = $1 AND route_id = $2 LIMIT 1`,
        [system, routeId]
      );
      if (rtRes.rows.length > 0) routeType = rtRes.rows[0].route_type;
    } catch {}
  }

  const fare = getFallbackFare(system, routeType);
  fareCache.set(cacheKey, fare);
  return fare;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFareObj(price, currency, transfers, transferDuration, source) {
  return {
    price,
    currency: currency || "USD",
    label: formatPrice(price, currency || "USD"),
    transfersIncluded: transfers === null ? "unlimited" : (transfers || 0),
    transferDurationSec: transferDuration ? parseInt(transferDuration) : null,
    source,
  };
}

function formatPrice(price, currency) {
  if (price === null || price === undefined) return "Varies";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(price);
}

function getFallbackFare(system, routeType) {
  const fb = FALLBACK_FARES[system];
  if (!fb) return { price: null, currency: "USD", label: "—", transfersIncluded: 0, transferDurationSec: null, source: "unknown" };

  if (fb.byType && routeType !== null && routeType !== undefined && fb.byType[routeType]) {
    const t = fb.byType[routeType];
    return buildFareObj(t.price, t.currency, t.transfers, t.transferDurationSec, "hardcoded");
  }

  if (fb.price !== undefined) {
    return buildFareObj(fb.price, fb.currency, fb.transfers, fb.transferDurationSec, "hardcoded");
  }

  const def = fb.default || { price: null, currency: "USD", transfers: 0 };
  return buildFareObj(def.price, def.currency, def.transfers, def.transferDurationSec, "hardcoded");
}

function buildFallbackResponse(system) {
  const fb = FALLBACK_FARES[system];
  if (!fb) return { system, source: "none", fares: [] };

  const fares = [];
  if (fb.byType) {
    for (const [type, info] of Object.entries(fb.byType)) {
      fares.push({
        fareId: `fallback-type-${type}`,
        price: info.price,
        currency: info.currency,
        label: info.label,
        paymentMethod: "pre-board",
        transfers: info.transfers === null ? "unlimited" : info.transfers,
        transferDurationSec: info.transferDurationSec || null,
        routeIds: [],
        note: info.note,
        routeType: parseInt(type),
      });
    }
  } else {
    fares.push({
      fareId: "fallback",
      price: fb.price,
      currency: fb.currency,
      label: fb.label,
      paymentMethod: "pre-board",
      transfers: fb.transfers === null ? "unlimited" : fb.transfers,
      transferDurationSec: fb.transferDurationSec || null,
      routeIds: [],
      note: fb.note,
    });
  }

  return { system, source: "hardcoded", fares };
}

// Invalidate cache on restart (singleton, so this runs once per process).
export function clearFareCache() {
  fareCache.clear();
}
