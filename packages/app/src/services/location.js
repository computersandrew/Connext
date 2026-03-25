// src/services/location.js
import * as Location from "expo-location";

// System bounding regions (center + radius in km)
const SYSTEM_REGIONS = [
  { id: "mta",   name: "MTA",   lat: 40.7128, lng: -74.0060, radiusKm: 35 },
  { id: "mbta",  name: "MBTA",  lat: 42.3601, lng: -71.0589, radiusKm: 40 },
  { id: "cta",   name: "CTA",   lat: 41.8781, lng: -87.6298, radiusKm: 30 },
  { id: "septa", name: "SEPTA", lat: 39.9526, lng: -75.1652, radiusKm: 30 },
  { id: "cdta",  name: "CDTA",  lat: 42.6526, lng: -73.7562, radiusKm: 70 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getLocation() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: loc.coords.latitude, lng: loc.coords.longitude };
  } catch {
    return null;
  }
}

export function detectSystem(lat, lng) {
  let closest = null;
  let closestDist = Infinity;

  for (const sys of SYSTEM_REGIONS) {
    const dist = haversineKm(lat, lng, sys.lat, sys.lng);
    if (dist < sys.radiusKm && dist < closestDist) {
      closest = sys;
      closestDist = dist;
    }
  }

  return closest;
}

export function findNearestStop(lat, lng, stops) {
  let nearest = null;
  let nearestDist = Infinity;

  for (const stop of stops) {
    if (!stop.lat || !stop.lon) continue;
    const dist = haversineKm(lat, lng, stop.lat, stop.lon);
    if (dist < nearestDist) {
      nearest = stop;
      nearestDist = dist;
    }
  }

  return nearest ? { ...nearest, distanceKm: nearestDist } : null;
}

export { SYSTEM_REGIONS };
