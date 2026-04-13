// src/screens/ResultsScreen.js
import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, Animated } from "react-native";
import { useTheme, spacing, radius, confidenceColor, urgencyColor } from "../theme";
import { api, connectDepartureStream } from "../services/api";
import { findNearestStops } from "../services/location";
import { API_BASE } from "../services/api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kmToMi(km) {
  if (km == null) return "";
  const mi = km * 0.621371;
  if (mi < 0.1) return `${Math.round(mi * 5280)} ft`;
  return `${mi.toFixed(1)} mi`;
}

function fmtTime(isoOrMs) {
  if (!isoOrMs) return null;
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtUnixTime(unix) {
  if (!unix) return null;
  return fmtTime(unix * 1000);
}

// Build per-leg start/end ms timestamps from route.leaveBy
function buildTimeline(rt) {
  const base = rt.leaveBy ? new Date(rt.leaveBy).getTime() : null;
  let cursor = base;
  return (rt.legs || []).map((leg) => {
    const startMs = cursor;
    let durMs = 0;
    if (leg.type === "walk" || leg.type === "ride") {
      durMs = (leg.durationSec || 0) * 1000;
    } else if (leg.type === "transfer") {
      durMs = ((leg.transferTimeSec || 0) + (leg.bufferSec || 0)) * 1000;
    }
    if (cursor !== null) cursor = cursor + durMs;
    return { ...leg, startMs, endMs: cursor };
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LinePill({ name, color, size = 28 }) {
  const display = (name || "?").length <= 3 ? name : (name || "?").charAt(0);
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.3,
      backgroundColor: color || "#888", alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{ color: "#fff", fontSize: size * 0.38, fontWeight: "800", letterSpacing: -0.5 }}>{display}</Text>
    </View>
  );
}

function ProbBadge({ probability }) {
  const { colors } = useTheme();
  if (probability == null) return null;
  const pct = Math.round(probability * 100);
  const c = confidenceColor(probability, colors);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: c + "15" }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: c }} />
      <Text style={{ color: c, fontSize: 12, fontWeight: "700" }}>{pct}%</Text>
    </View>
  );
}

function TickingCountdown({ departureTime }) {
  const { colors } = useTheme();
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);
  if (!departureTime) return <Text style={{ fontSize: 12, color: colors.textMuted }}>Sched</Text>;
  const sec = departureTime - now;
  if (sec <= 0) return <Text style={{ fontSize: 15, fontWeight: "800", color: colors.red, letterSpacing: 0.5 }}>NOW</Text>;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;

  if (sec > 3600) {
    const hrs = Math.floor(sec / 3600);
    const remMin = Math.floor((sec % 3600) / 60);
    return (
      <View style={{ alignItems: "flex-end" }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: urgencyColor(sec, colors), fontVariant: ["tabular-nums"] }}>
          {hrs}h {remMin}m
        </Text>
        <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 1 }}>away</Text>
      </View>
    );
  }

  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text style={{ fontSize: sec <= 60 ? 24 : 20, fontWeight: "700", color: urgencyColor(sec, colors), fontVariant: ["tabular-nums"] }}>
        {min}:{String(remSec).padStart(2, "0")}
      </Text>
      <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 1 }}>{min === 0 ? "seconds" : "min"}</Text>
    </View>
  );
}

// Expanded itinerary for a planner route card
function RouteDetail({ route, stopNames }) {
  const { colors } = useTheme();
  const timeline = buildTimeline(route);

  const rows = [];
  timeline.forEach((leg, li) => {
    if (leg.type === "walk") {
      const distStr = kmToMi(leg.distanceKm);
      rows.push(
        <View key={`w-${li}`} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 12 }}>
          <View style={{ width: 28, alignItems: "center" }}>
            <Text style={{ fontSize: 16 }}>🚶</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>
              Walk {distStr ? `${distStr} · ` : ""}{leg.durationMin} min
            </Text>
            {(() => {
              // Show "to [destination]" only when it's a named stop, not a generic "to stop"
              const dest = leg.description?.match(/to\s+(.+)$/i)?.[1];
              if (!dest || dest.toLowerCase() === 'stop') return null;
              return <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>to {dest}</Text>;
            })()}
          </View>
          {leg.startMs && (
            <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: "500" }}>{fmtTime(leg.startMs)}</Text>
          )}
        </View>
      );
    } else if (leg.type === "ride") {
      const fromName = stopNames?.[leg.fromStopId] || stopNames?.[leg.from] || leg.from || leg.fromStopId || "—";
      const toName = stopNames?.[leg.toStopId] || stopNames?.[leg.to] || leg.to || leg.toStopId || "—";
      const depTime = leg.startMs ? fmtTime(leg.startMs) : null;
      const arrTime = leg.endMs ? fmtTime(leg.endMs) : null;
      rows.push(
        <View key={`r-${li}`} style={{
          marginVertical: 6, padding: 12, borderRadius: radius.lg,
          backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.cardBorder,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <LinePill name={leg.routeName} color={leg.routeColor} size={24} />
            <Text style={{ color: colors.text, fontWeight: "700", fontSize: 15 }}>{leg.routeName}</Text>
            {leg.direction ? (
              <Text style={{ color: colors.textMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>→ {leg.direction}</Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>Board</Text>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: "500", marginTop: 2 }} numberOfLines={1}>{fromName}</Text>
              {depTime && <Text style={{ color: colors.blue, fontSize: 13, fontWeight: "600", marginTop: 2 }}>{depTime}</Text>}
            </View>
            <View style={{ alignItems: "center", justifyContent: "center", paddingHorizontal: 10 }}>
              <Text style={{ color: colors.textMuted, fontSize: 18 }}>→</Text>
              <Text style={{ color: colors.textMuted, fontSize: 11 }}>{leg.durationMin}m</Text>
            </View>
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              <Text style={{ color: colors.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>Alight</Text>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: "500", marginTop: 2, textAlign: "right" }} numberOfLines={1}>{toName}</Text>
              {arrTime && <Text style={{ color: colors.blue, fontSize: 13, fontWeight: "600", marginTop: 2 }}>{arrTime}</Text>}
            </View>
          </View>
        </View>
      );
    } else if (leg.type === "transfer") {
      const pc = confidenceColor(leg.probability || 1, colors);
      rows.push(
        <View key={`t-${li}`} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 12 }}>
          <View style={{ width: 28, alignItems: "center" }}>
            <Text style={{ color: colors.textMuted, fontSize: 16 }}>{leg.platformChange ? "↕" : "→"}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: "500" }}>
              Transfer at {leg.station || "—"}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
              {leg.transferTimeMin}m window · {Math.round((leg.probability || 1) * 100)}% catch rate
              {leg.platformChange ? " · Platform change" : ""}
            </Text>
          </View>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: pc }} />
        </View>
      );
    }
  });

  return (
    <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.cardBorder }}>
      {rows}
    </View>
  );
}

// Expanded detail for a departure row (timetable mode)
function DepartureDetail({ dep, system }) {
  const { colors } = useTheme();
  const statusColor = dep.delay && dep.delay > 60 ? colors.yellow : colors.green;
  const delayMin = dep.delay ? Math.round(dep.delay / 60) : 0;
  const [vehicle, setVehicle] = useState(null);
  const [vehicleLoading, setVehicleLoading] = useState(false);

  useEffect(() => {
    if (!dep.tripId || !system) return;
    setVehicleLoading(true);
    api.vehicleByTrip(system, dep.tripId)
      .then((data) => setVehicle(data.vehicle || null))
      .catch(() => setVehicle(null))
      .finally(() => setVehicleLoading(false));
  }, [dep.tripId, system]);

  // Speed stored as m/s from GTFS-RT; convert to mph
  const speedMph = vehicle?.speed != null ? Math.round(vehicle.speed * 2.23694) : null;

  return (
    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.cardBorder }}>
      <View style={{ gap: 7 }}>
        {dep.tripId ? (
          <DetailRow label="Trip" value={String(dep.tripId)} colors={colors} />
        ) : null}
        <DetailRow label="Route" value={dep.routeName || dep.routeId} colors={colors} />
        {dep.direction ? (
          <DetailRow label="To" value={dep.direction} colors={colors} />
        ) : null}
        {dep.stopName ? (
          <DetailRow label="Stop" value={dep.stopName} colors={colors} />
        ) : null}
        <DetailRow
          label="Departs"
          value={fmtUnixTime(dep.departureTime) || "—"}
          colors={colors}
        />
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: colors.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6 }}>Status</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusColor }} />
            <Text style={{ color: statusColor, fontSize: 13, fontWeight: "600" }}>
              {delayMin > 0 ? `+${delayMin} min late` : "On time"}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: colors.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6 }}>Data</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: dep.isRealtime ? colors.green : colors.textMuted }} />
            <Text style={{ color: dep.isRealtime ? colors.green : colors.textSecondary, fontSize: 13, fontWeight: "500" }}>
              {dep.isRealtime ? "Live tracking" : "Scheduled"}
            </Text>
          </View>
        </View>

        {/* Live vehicle position section */}
        {vehicleLoading && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>Loading vehicle data…</Text>
          </View>
        )}
        {vehicle && !vehicleLoading && (
          <View style={{
            marginTop: 10, paddingTop: 10,
            borderTopWidth: 1, borderTopColor: colors.cardBorder,
            gap: 7,
          }}>
            <Text style={{ fontSize: 11, color: colors.accent, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>
              Live Vehicle
            </Text>
            {vehicle.vehicleId != null ? (
              <DetailRow label="Train #" value={String(vehicle.vehicleId)} colors={colors} />
            ) : null}
            {vehicle.service ? (
              <DetailRow label="Service" value={vehicle.service} colors={colors} />
            ) : null}
            {vehicle.source && vehicle.dest ? (
              <DetailRow label="Route" value={`${vehicle.source} → ${vehicle.dest}`} colors={colors} />
            ) : null}
            {vehicle.currentStop ? (
              <DetailRow label="At" value={String(vehicle.currentStop)} colors={colors} />
            ) : null}
            {vehicle.nextStop ? (
              <DetailRow label="Next Stop" value={String(vehicle.nextStop)} colors={colors} />
            ) : null}
            {vehicle.track ? (
              <DetailRow
                label="Track"
                value={vehicle.trackChange ? `${vehicle.track} ⚠ changed` : String(vehicle.track)}
                colors={colors}
              />
            ) : null}
            {vehicle.consist ? (
              <DetailRow label="Consist" value={String(vehicle.consist)} colors={colors} />
            ) : null}
            {vehicle.lateMin != null ? (
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: colors.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 1 }}>On Time</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: vehicle.lateMin > 0 ? colors.yellow : colors.green }} />
                  <Text style={{ color: vehicle.lateMin > 0 ? colors.yellow : colors.green, fontSize: 13, fontWeight: "600" }}>
                    {vehicle.lateMin > 0 ? `+${vehicle.lateMin} min late` : "On time"}
                  </Text>
                </View>
              </View>
            ) : null}
            {speedMph !== null && speedMph >= 0 ? (
              <DetailRow label="Speed" value={`${speedMph} mph`} colors={colors} />
            ) : null}
            {vehicle.bearing != null ? (
              <DetailRow label="Heading" value={`${Math.round(vehicle.bearing)}°`} colors={colors} />
            ) : null}
            {vehicle.lat != null && vehicle.lng != null ? (
              <DetailRow
                label="Position"
                value={`${vehicle.lat.toFixed(4)}°, ${vehicle.lng.toFixed(4)}°`}
                colors={colors}
              />
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

function DetailRow({ label, value, colors }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
      <Text style={{ color: colors.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 1 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: "500", flex: 1, textAlign: "right", marginLeft: 12 }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function ResultsScreen({ route, navigation, pace }) {
  const { colors } = useTheme();
  const { system, destinationStopId, destinationName, userLat, userLng, appMode = "connection" } = route.params;

  const [routes, setRoutes] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [mode, setMode] = useState(null);
  const [originName, setOriginName] = useState("Your location");
  const [loading, setLoading] = useState(true);
  const [stopNames, setStopNames] = useState({});
  const [expandedRoute, setExpandedRoute] = useState(null);
  const [expandedDep, setExpandedDep] = useState(null);
  const wsRef = useRef(null);
  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    (async () => {
      try {
        let foundRoutes = false;

        // Always fetch stops for name lookup (both modes need it for walk descriptions)
        try {
          const stopsResp = await fetch(`${API_BASE}/api/v1/stops/${system}`, { headers: { Accept: "application/json" } });
          const stopsData = await stopsResp.json();
          const map = {};
          (stopsData.stops || []).forEach((s) => { map[s.stopId] = s.name; });
          setStopNames(map);

          // Connection mode: try to plan a route
          if (appMode !== "timetable" && userLat && userLng) {
            const allStops = stopsData.stops || [];
            if (allStops.length > 0) {
              const candidates = findNearestStops(userLat, userLng, allStops, 10);
              for (const candidate of candidates) {
                if (candidate.stopId === destinationStopId) continue;
                try {
                  const planData = await api.plan(system, candidate.stopId, destinationStopId, {
                    pace, walkDistKm: candidate.distanceKm, lat: userLat, lng: userLng,
                  });
                  const hasRealRoutes = planData.routes?.some(
                    (r) => r.type === "direct" || r.type === "one_transfer" || r.type === "two_transfers"
                  );
                  if (hasRealRoutes) {
                    setOriginName(candidate.name);
                    setRoutes(planData.routes);
                    setMode("planner");
                    foundRoutes = true;
                    break;
                  }
                } catch {}
              }
            }
          }
        } catch {}

        // Timetable mode or fallback: show departures
        if (!foundRoutes) {
          setMode("departures");
          try {
            const depData = await api.departures(system, destinationStopId, { limit: 20 });
            setDepartures(depData.departures || []);
          } catch {
            try {
              const stopsData = await api.departureStops(system);
              const match = (stopsData.stops || []).find((s) => s.includes(destinationStopId) || destinationStopId.includes(s));
              if (match) {
                const depData = await api.departures(system, match, { limit: 20 });
                setDepartures(depData.departures || []);
              }
            } catch {}
          }
          wsRef.current = connectDepartureStream(system, destinationStopId, (data) => {
            setDepartures(data.departures || []);
          });
        }

        try {
          const alertData = await api.alertsBySystem(system);
          setAlerts(alertData.alerts || []);
        } catch {}

      } catch {} finally {
        setLoading(false);
        Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
      }
    })();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [system, destinationStopId, userLat, userLng, pace, appMode]);

  const systemName = { mta: "MTA", mbta: "MBTA", cta: "CTA", septa: "SEPTA" }[system] || system;

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.textMuted} />
        <Text style={{ color: colors.textSecondary, fontSize: 15, marginTop: 16, letterSpacing: 0.2 }}>
          {appMode === "timetable" ? "Loading timetable..." : "Finding routes..."}
        </Text>
      </View>
    );
  }

  const routeIds = new Set([
    ...routes.flatMap((r) => r.legs?.filter((l) => l.routeId).map((l) => l.routeId) || []),
    ...departures.map((d) => d.routeId).filter(Boolean),
  ]);
  const relevantAlerts = alerts.filter((a) => a.routeIds?.some((r) => routeIds.has(r))).slice(0, 2);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 50 }}>
        <Animated.View style={{ opacity: fadeIn }}>

          {/* ─── Header ─── */}
          {mode === "planner" ? (
            <View style={{ marginBottom: 24 }}>
              <Text style={{ fontSize: 13, color: colors.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>FROM</Text>
              <Text style={{ fontSize: 17, color: colors.textSecondary, fontWeight: "500", marginBottom: 16, letterSpacing: 0.1 }}>{originName}</Text>
              <Text style={{ fontSize: 13, color: colors.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>TO</Text>
              <Text style={{ fontSize: 26, color: colors.text, fontWeight: "700", letterSpacing: -0.5 }}>{destinationName}</Text>
            </View>
          ) : (
            <View style={{ marginBottom: 24 }}>
              <Text style={{ fontSize: 26, color: colors.text, fontWeight: "700", letterSpacing: -0.5, marginBottom: 6 }}>{destinationName}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 14, color: colors.textSecondary }}>{systemName}</Text>
                <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textMuted }} />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
                  <Text style={{ fontSize: 12, color: colors.green, fontWeight: "600" }}>
                    {appMode === "timetable" ? "Timetable" : "Live"}
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* ─── Alerts ─── */}
          {relevantAlerts.map((alert, i) => {
            const sc = alert.severity === "severe" ? colors.red : alert.severity === "moderate" ? colors.yellow : colors.blue;
            return (
              <View key={`alert-${i}`} style={{ padding: 14, borderRadius: radius.lg, marginBottom: 10, backgroundColor: sc + "08", borderWidth: 1, borderColor: sc + "20" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: sc }} />
                  <Text style={{ fontSize: 11, fontWeight: "700", color: sc, textTransform: "uppercase", letterSpacing: 0.8 }}>{alert.type || "alert"}</Text>
                </View>
                <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 19 }} numberOfLines={2}>{alert.headerText}</Text>
              </View>
            );
          })}

          {/* ═══ PLANNER / CONNECTION MODE ═══ */}
          {mode === "planner" && routes.length === 0 && (
            <View style={{ alignItems: "center", paddingVertical: 36 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 16, fontWeight: "500" }}>No connections found</Text>
              <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>Try a different destination</Text>
            </View>
          )}

          {mode === "planner" && routes.map((rt, ri) => {
            const isExpanded = expandedRoute === ri;
            // Compute actual elapsed time from the timeline so it matches
            // the expanded itinerary (accounts for real scheduled wait at transfers).
            const _tl = buildTimeline(rt);
            const _firstMs = _tl[0]?.startMs;
            const _lastMs = _tl[_tl.length - 1]?.endMs;
            const displayMin = (_firstMs && _lastMs)
              ? Math.round((_lastMs - _firstMs) / 60000)
              : rt.totalTimeMin;
            return (
              <Pressable
                key={rt.id || ri}
                onPress={() => setExpandedRoute(isExpanded ? null : ri)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? colors.cardActive : colors.card,
                  borderRadius: radius.xl, padding: 20, marginBottom: 12,
                  borderWidth: 1, borderColor: isExpanded ? colors.accent + "60" : colors.cardBorder,
                })}
              >
                {/* Summary row */}
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                    <Text style={{ fontSize: 28, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: -1 }}>
                      {displayMin}
                    </Text>
                    <Text style={{ fontSize: 14, color: colors.textSecondary, marginLeft: 2 }}>min</Text>
                    {rt.transfers > 0 && (
                      <Text style={{ fontSize: 12, color: colors.textMuted, marginLeft: 10 }}>
                        {rt.transfers} transfer{rt.transfers > 1 ? "s" : ""}
                      </Text>
                    )}
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    {rt.fare?.label ? (
                      <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: colors.cardBorder }}>
                        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: "600" }}>{rt.fare.label}</Text>
                      </View>
                    ) : null}
                    <ProbBadge probability={rt.overallProbability} />
                    <Text style={{ color: colors.textMuted, fontSize: 16 }}>{isExpanded ? "▾" : "›"}</Text>
                  </View>
                </View>

                {/* Leg pills */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {rt.legs.map((leg, li) => {
                    if (leg.type === "walk") return (
                      <View key={`w-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <Text style={{ fontSize: 14 }}>🚶</Text>
                        <Text style={{ fontSize: 12, color: colors.textMuted }}>
                          {kmToMi(leg.distanceKm) || `${leg.durationMin}m`}
                        </Text>
                      </View>
                    );
                    if (leg.type === "ride") return (
                      <View key={`r-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <LinePill name={leg.routeName} color={leg.routeColor} size={26} />
                        <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: "500" }}>{leg.durationMin}m</Text>
                      </View>
                    );
                    if (leg.type === "transfer") {
                      const pc = confidenceColor(leg.probability, colors);
                      return (
                        <View key={`t-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                          <View style={{ width: 16, height: 1, backgroundColor: colors.textMuted }} />
                          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: pc + "12", borderWidth: 1, borderColor: pc + "25" }}>
                            <Text style={{ fontSize: 10, color: pc, fontWeight: "700" }}>
                              {leg.transferTimeMin}m {leg.platformChange ? "↕" : "→"}
                            </Text>
                          </View>
                          <View style={{ width: 16, height: 1, backgroundColor: colors.textMuted }} />
                        </View>
                      );
                    }
                    return null;
                  })}
                </View>

                {/* Leave by (collapsed) */}
                {!isExpanded && rt.leaveBy && (
                  <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: "600", marginTop: 10 }}>
                    Leave by {fmtTime(rt.leaveBy)}
                  </Text>
                )}

                {/* ─── Expanded itinerary ─── */}
                {isExpanded && <RouteDetail route={rt} stopNames={stopNames} />}
              </Pressable>
            );
          })}

          {/* ═══ DEPARTURES / TIMETABLE MODE ═══ */}
          {mode === "departures" && departures.length === 0 && (
            <View style={{ alignItems: "center", paddingVertical: 36 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 16, fontWeight: "500" }}>No departures right now</Text>
              <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>This station may not have active service</Text>
            </View>
          )}

          {mode === "departures" && departures.map((dep, i) => {
            const depKey = dep.tripId || `${dep.routeId}-${i}`;
            const isExpanded = expandedDep === depKey;
            return (
              <Pressable
                key={depKey}
                onPress={() => setExpandedDep(isExpanded ? null : depKey)}
                style={({ pressed }) => ({
                  paddingVertical: 14, paddingHorizontal: 4,
                  borderBottomWidth: i < departures.length - 1 ? 1 : 0,
                  borderBottomColor: colors.cardBorder,
                  backgroundColor: pressed ? colors.cardActive : "transparent",
                  borderRadius: isExpanded ? radius.lg : 0,
                  marginHorizontal: isExpanded ? -4 : 0,
                  paddingHorizontal: isExpanded ? 12 : 4,
                  marginBottom: isExpanded ? 4 : 0,
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 14, flex: 1 }}>
                    <LinePill name={dep.routeName} color={dep.routeColor} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 16, fontWeight: "500", letterSpacing: 0.1 }} numberOfLines={1}>
                        {dep.routeName || dep.routeId}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                        {dep.direction || dep.stopName}
                      </Text>
                    </View>
                  </View>
                  <View style={{ alignItems: "flex-end", flexDirection: "row", gap: 8 }}>
                    <View style={{ alignItems: "flex-end" }}>
                      <TickingCountdown departureTime={dep.departureTime} />
                      {dep.delay && dep.delay > 60 ? (
                        <Text style={{ fontSize: 10, color: colors.yellow, fontWeight: "600", marginTop: 2 }}>
                          +{Math.round(dep.delay / 60)}m late
                        </Text>
                      ) : null}
                    </View>
                    <Text style={{ color: colors.textMuted, fontSize: 16, alignSelf: "center" }}>{isExpanded ? "▾" : "›"}</Text>
                  </View>
                </View>

                {/* ─── Expanded departure detail ─── */}
                {isExpanded && <DepartureDetail dep={dep} system={system} />}
              </Pressable>
            );
          })}

          {/* View departures link in planner mode */}
          {mode === "planner" && routes.length > 0 && (
            <Pressable
              onPress={() => navigation.navigate("Departures", { system, stop: destinationStopId, stopName: destinationName })}
              style={{ alignItems: "center", marginTop: 20, paddingVertical: 12 }}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
                View departures at {destinationName} →
              </Text>
            </Pressable>
          )}

        </Animated.View>
      </ScrollView>
    </View>
  );
}
