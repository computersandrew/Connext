// src/screens/ResultsScreen.js
import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { colors, spacing, fontSize, radius, confidenceColor, urgencyColor } from "../theme";
import { api, connectDepartureStream } from "../services/api";
import { findNearestStop } from "../services/location";
import { API_BASE } from "../services/api";

function LinePill({ name, color, size = 24 }) {
  const display = name?.length <= 3 ? name : name?.charAt(0) || "?";
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color || "#888", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontSize: size * 0.38, fontWeight: "700" }}>{display}</Text>
    </View>
  );
}

function ProbabilityBadge({ probability }) {
  if (probability == null) return null;
  const pct = Math.round(probability * 100);
  const color = confidenceColor(probability);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: color + "18" }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{pct}%</Text>
    </View>
  );
}

export default function ResultsScreen({ route, navigation, pace }) {
  const { system, destinationStopId, destinationName, userLat, userLng } = route.params;
  const [routes, setRoutes] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [mode, setMode] = useState(null); // "planner" | "departures"
  const [originName, setOriginName] = useState("Your location");
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        // ── Step 1: Try to find an origin and plan a route ──────────
        let foundRoutes = false;

        if (userLat && userLng) {
          try {
            const resp = await fetch(`${API_BASE}/api/v1/stops/${system}`, {
              headers: { "Accept": "application/json" },
            });
            const data = await resp.json();

            // Get active departure stops to filter
            const depData = await api.departureStops(system);
            const activeSet = new Set(depData.stops || []);
            const stopsWithData = (data.stops || []).filter((s) => activeSet.has(s.stopId));

            if (stopsWithData.length > 0) {
              const nearest = findNearestStop(userLat, userLng, stopsWithData);
              if (nearest && nearest.stopId !== destinationStopId) {
                setOriginName(nearest.name);
                const planData = await api.plan(system, nearest.stopId, destinationStopId, { pace });
                if (planData.routes?.length > 0) {
                  setRoutes(planData.routes);
                  setMode("planner");
                  foundRoutes = true;
                }
              }
            }
          } catch {}
        }

        // ── Step 2: Fallback — show departures from destination ─────
        if (!foundRoutes) {
          setMode("departures");
          try {
            const depData = await api.departures(system, destinationStopId, { limit: 15 });
            setDepartures(depData.departures || []);
          } catch {
            // Try alternate stop ID formats
            try {
              // Some systems use different key formats
              const stopsData = await api.departureStops(system);
              const stops = stopsData.stops || [];
              // Find a stop that contains our destination ID
              const match = stops.find((s) => s.includes(destinationStopId) || destinationStopId.includes(s));
              if (match) {
                const depData = await api.departures(system, match, { limit: 15 });
                setDepartures(depData.departures || []);
              }
            } catch {}
          }

          // Start WebSocket for live updates
          wsRef.current = connectDepartureStream(system, destinationStopId, (data) => {
            setDepartures(data.departures || []);
          });
        }

        // ── Step 3: Fetch relevant alerts ───────────────────────────
        try {
          const alertData = await api.alertsBySystem(system);
          const allAlerts = alertData.alerts || [];
          // Filter to alerts affecting routes at this station
          const routeIds = new Set([
            ...routes.flatMap((r) => r.legs?.filter((l) => l.routeId).map((l) => l.routeId) || []),
            ...departures.map((d) => d.routeId).filter(Boolean),
          ]);
          const relevant = allAlerts.filter((a) =>
            a.routeIds?.some((r) => routeIds.has(r))
          );
          setAlerts(relevant.length > 0 ? relevant : allAlerts.slice(0, 2));
        } catch {}

      } catch {} finally {
        setLoading(false);
      }
    })();

    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [system, destinationStopId, userLat, userLng, pace]);

  const systemName = { mta: "MTA", mbta: "MBTA", cta: "CTA", septa: "SEPTA" }[system] || system;

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.textSecondary} />
        <Text style={{ color: colors.textSecondary, fontSize: 14, marginTop: 12 }}>Finding routes...</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>

        {/* Header */}
        {mode === "planner" && (
          <View style={{ marginBottom: 20 }}>
            <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>From</Text>
            <Text style={{ fontSize: 16, color: colors.textSecondary, fontWeight: "500", marginBottom: 12 }}>{originName}</Text>
            <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>To</Text>
            <Text style={{ fontSize: 22, color: colors.text, fontWeight: "700" }}>{destinationName}</Text>
          </View>
        )}

        {mode === "departures" && (
          <View style={{ marginBottom: 20 }}>
            <Text style={{ fontSize: 22, color: colors.text, fontWeight: "700", marginBottom: 2 }}>
              {destinationName}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary }}>{systemName}</Text>
              <Text style={{ color: colors.textMuted }}>·</Text>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.green }} />
              <Text style={{ fontSize: 12, color: colors.green, fontWeight: "500" }}>Live departures</Text>
            </View>
          </View>
        )}

        {/* Relevant alerts */}
        {alerts.filter((a) => {
          const routeIds = new Set([
            ...routes.flatMap((r) => r.legs?.filter((l) => l.routeId).map((l) => l.routeId) || []),
            ...departures.map((d) => d.routeId).filter(Boolean),
          ]);
          return a.routeIds?.some((r) => routeIds.has(r));
        }).slice(0, 2).map((alert, i) => {
          const sevColor = alert.severity === "severe" ? colors.red : alert.severity === "moderate" ? colors.yellow : colors.blue;
          return (
            <View key={`alert-${i}`} style={{
              padding: 12, borderRadius: radius.md, marginBottom: 8,
              backgroundColor: sevColor + "08", borderWidth: 1, borderColor: sevColor + "25",
            }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: sevColor }} />
                <Text style={{ fontSize: 11, fontWeight: "700", color: sevColor, textTransform: "uppercase" }}>
                  {alert.type || "alert"}
                </Text>
              </View>
              <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 18 }} numberOfLines={2}>
                {alert.headerText}
              </Text>
            </View>
          );
        })}

        {/* ═══ PLANNER MODE ═══ */}
        {mode === "planner" && routes.map((rt, ri) => (
          <Pressable
            key={rt.id || ri}
            style={{
              backgroundColor: colors.card, borderRadius: radius.lg, padding: 16,
              marginBottom: 10, borderWidth: 1, borderColor: colors.cardBorder,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                <Text style={{ fontSize: 24, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] }}>
                  {rt.totalTimeMin}
                </Text>
                <Text style={{ fontSize: 13, color: colors.textSecondary }}>min</Text>
                {rt.transfers > 0 && (
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>
                    {rt.transfers} transfer{rt.transfers > 1 ? "s" : ""}
                  </Text>
                )}
              </View>
              <ProbabilityBadge probability={rt.overallProbability} />
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {rt.legs.map((leg, li) => {
                if (leg.type === "walk") return (
                  <View key={`w-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Text style={{ fontSize: 12 }}>🚶</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>{leg.durationMin}m</Text>
                  </View>
                );
                if (leg.type === "ride") return (
                  <View key={`r-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <LinePill name={leg.routeName} color={leg.routeColor} />
                    <Text style={{ fontSize: 12, color: colors.textSecondary }}>{leg.durationMin}m</Text>
                  </View>
                );
                if (leg.type === "transfer") {
                  const pc = confidenceColor(leg.probability);
                  return (
                    <View key={`t-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                      <Text style={{ fontSize: 10, color: colors.textMuted }}>→</Text>
                      <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: pc + "15" }}>
                        <Text style={{ fontSize: 10, color: pc, fontWeight: "600" }}>{leg.transferTimeMin}m</Text>
                      </View>
                      <Text style={{ fontSize: 10, color: colors.textMuted }}>→</Text>
                    </View>
                  );
                }
                return null;
              })}
            </View>

            {rt.leaveBy && (
              <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 10 }}>
                Leave by {new Date(rt.leaveBy).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </Text>
            )}
          </Pressable>
        ))}

        {/* ═══ DEPARTURES MODE ═══ */}
        {mode === "departures" && departures.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 32 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 15, marginBottom: 4 }}>No departures right now</Text>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>This station may not have active service</Text>
          </View>
        )}

        {mode === "departures" && departures.map((dep, i) => {
          const secAway = dep.secondsAway;
          const minAway = dep.minutesAway;
          const isImm = secAway !== null && secAway <= 60;

          return (
            <View
              key={`${dep.tripId}-${i}`}
              style={{
                flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
                <LinePill name={dep.routeName} color={dep.routeColor} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }} numberOfLines={1}>
                    {dep.routeName || dep.routeId}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                    {dep.direction || dep.stopName}
                  </Text>
                </View>
              </View>

              <View style={{ alignItems: "flex-end", minWidth: 50 }}>
                  {secAway !== null && secAway <= 0 && (
                    <Text style={{ fontSize: 14, fontWeight: "800", color: colors.red }}>NOW</Text>
                  )}
                  {secAway !== null && secAway > 0 && (
                    <Text style={{ fontSize: isImm ? 22 : 18, fontWeight: "700", color: urgencyColor(secAway), fontVariant: ["tabular-nums"] }}>
                      {minAway}
                      <Text style={{ fontSize: 11, fontWeight: "400", color: colors.textSecondary }}> min</Text>
                    </Text>
                  )}
                  {secAway === null && (
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>Sched</Text>
                  )}
                  {dep.delay && dep.delay > 0 ? (
                    <Text style={{ fontSize: 10, color: colors.yellow, fontWeight: "600", marginTop: 1 }}>
                      +{Math.round(dep.delay / 60)}m late
                    </Text>
                  ) : null}
                </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
