// connext-ingestion/src/utils/protobuf.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared GTFS-RT protobuf parsing utilities
// All adapters use these to decode feeds into JS objects.
// ─────────────────────────────────────────────────────────────────────────────

import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtimeBindings;
const FeedMessage = transit_realtime.FeedMessage;

/**
 * Decode a raw protobuf buffer into a GTFS-RT FeedMessage
 * @param {Buffer} buffer
 * @returns {object} - Decoded FeedMessage with header and entity array
 */
export function decodeFeed(buffer) {
  return FeedMessage.decode(new Uint8Array(buffer));
}

/**
 * Extract trip update entities from a decoded feed
 * @param {object} feed - Decoded FeedMessage
 * @returns {Array<object>} - Array of { id, tripUpdate } objects
 */
export function extractTripUpdates(feed) {
  return (feed.entity || [])
    .filter((e) => e.tripUpdate)
    .map((e) => ({
      id: e.id,
      tripUpdate: e.tripUpdate,
    }));
}

/**
 * Extract vehicle position entities from a decoded feed
 * @param {object} feed - Decoded FeedMessage
 * @returns {Array<object>} - Array of { id, vehicle } objects
 */
export function extractVehiclePositions(feed) {
  return (feed.entity || [])
    .filter((e) => e.vehicle)
    .map((e) => ({
      id: e.id,
      vehicle: e.vehicle,
    }));
}

/**
 * Extract alert entities from a decoded feed
 * @param {object} feed - Decoded FeedMessage
 * @returns {Array<object>} - Array of { id, alert } objects
 */
export function extractAlerts(feed) {
  return (feed.entity || [])
    .filter((e) => e.alert)
    .map((e) => ({
      id: e.id,
      alert: e.alert,
    }));
}

/**
 * Safely extract a translated string from a GTFS-RT TranslatedString
 * Prefers English, falls back to first available, then empty string
 * @param {object} translatedString
 * @returns {string}
 */
export function getTranslatedText(translatedString) {
  if (!translatedString || !translatedString.translation) return "";
  const translations = translatedString.translation;
  const en = translations.find((t) => t.language === "en" || t.language === "EN");
  if (en) return en.text || "";
  return translations[0]?.text || "";
}

/**
 * Convert a GTFS-RT StopTimeEvent to a Unix timestamp
 * Handles both `time` (absolute) and `delay` (relative) formats
 * @param {object} stopTimeEvent - { time, delay, uncertainty }
 * @param {number|null} scheduledTime - Scheduled time (Unix) for delay calculation
 * @returns {{ time: number|null, delay: number|null }}
 */
export function resolveStopTime(stopTimeEvent, scheduledTime = null) {
  if (!stopTimeEvent) return { time: null, delay: null };

  // Some feeds provide time as a Long object
  const rawTime = stopTimeEvent.time;
  const time = rawTime
    ? (typeof rawTime === "object" && rawTime.toNumber ? rawTime.toNumber() : Number(rawTime))
    : null;

  const delay = stopTimeEvent.delay ?? null;

  // If we have absolute time, derive delay from schedule
  if (time && scheduledTime && delay === null) {
    return { time, delay: time - scheduledTime };
  }

  // If we have delay but not absolute time, derive time from schedule
  if (delay !== null && !time && scheduledTime) {
    return { time: scheduledTime + delay, delay };
  }

  return { time, delay };
}

/**
 * Map GTFS-RT VehicleStopStatus enum to a readable string
 */
export function mapVehicleStatus(status) {
  const map = {
    0: "INCOMING",      // INCOMING_AT
    1: "STOPPED",       // STOPPED_AT
    2: "IN_TRANSIT",    // IN_TRANSIT_TO
  };
  return map[status] || "IN_TRANSIT";
}

/**
 * Map a GTFS route_type integer to a Connext type string
 */
export function mapRouteType(gtfsRouteType) {
  const map = {
    0: "light_rail",
    1: "subway",
    2: "rail",
    3: "bus",
    4: "ferry",
    5: "cable_car",
    6: "gondola",
    7: "funicular",
    11: "trolley",
    12: "monorail",
  };
  return map[gtfsRouteType] || "other";
}
