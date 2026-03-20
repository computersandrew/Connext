// connext-ingestion/src/utils/protobuf.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared GTFS-RT protobuf parsing utilities
// Uses protobufjs with .proto file directly (handles unknown extensions gracefully)
// ─────────────────────────────────────────────────────────────────────────────

import protobuf from "protobufjs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "..", "..", "gtfs-realtime.proto");

let FeedMessage = null;

async function getFeedMessage() {
  if (!FeedMessage) {
    const root = await protobuf.load(PROTO_PATH);
    FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  }
  return FeedMessage;
}

// Pre-load on import
const _ready = getFeedMessage();

export async function decodeFeed(buffer) {
  const FM = await getFeedMessage();
  return FM.decode(new Uint8Array(buffer));
}

export function extractTripUpdates(feed) {
  return (feed.entity || [])
    .filter((e) => e.tripUpdate)
    .map((e) => ({ id: e.id, tripUpdate: e.tripUpdate }));
}

export function extractVehiclePositions(feed) {
  return (feed.entity || [])
    .filter((e) => e.vehicle)
    .map((e) => ({ id: e.id, vehicle: e.vehicle }));
}

export function extractAlerts(feed) {
  return (feed.entity || [])
    .filter((e) => e.alert)
    .map((e) => ({ id: e.id, alert: e.alert }));
}

export function getTranslatedText(translatedString) {
  if (!translatedString || !translatedString.translation) return "";
  const translations = translatedString.translation;
  const en = translations.find((t) => t.language === "en" || t.language === "EN");
  if (en) return en.text || "";
  return translations[0]?.text || "";
}

export function resolveStopTime(stopTimeEvent, scheduledTime = null) {
  if (!stopTimeEvent) return { time: null, delay: null };
  const rawTime = stopTimeEvent.time;
  const time = rawTime
    ? (typeof rawTime === "object" && rawTime.toNumber ? rawTime.toNumber() : Number(rawTime))
    : null;
  const delay = stopTimeEvent.delay ?? null;
  if (time && scheduledTime && delay === null) return { time, delay: time - scheduledTime };
  if (delay !== null && !time && scheduledTime) return { time: scheduledTime + delay, delay };
  return { time, delay };
}

export function mapVehicleStatus(status) {
  const map = { 0: "INCOMING", 1: "STOPPED", 2: "IN_TRANSIT" };
  return map[status] || "IN_TRANSIT";
}

export function mapRouteType(gtfsRouteType) {
  const map = { 0: "light_rail", 1: "subway", 2: "rail", 3: "bus", 4: "ferry", 5: "cable_car", 6: "gondola", 7: "funicular", 11: "trolley", 12: "monorail" };
  return map[gtfsRouteType] || "other";
}
