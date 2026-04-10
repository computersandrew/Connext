// src/screens/ResultsScreen.js
import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, Animated } from "react-native";
import { useTheme, spacing, fontSize, radius, confidenceColor, urgencyColor } from "../theme";
import { api, connectDepartureStream } from "../services/api";
import { findNearestStop } from "../services/location";
import { API_BASE } from "../services/api";

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
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 5,
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
      backgroundColor: c + "15",
    }}>
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
  const isImm = sec <= 60;
  const isSoon = sec <= 180;

  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text style={{
        fontSize: isImm ? 24 : 20, fontWeight: "700",
        color: urgencyColor(sec, colors), fontVariant: ["tabular-nums"],
      }}>
        {min}:{String(remSec).padStart(2, "0")}
      </Text>
      <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 1 }}>
        {min === 0 ? "seconds" : "min"}
      </Text>
    </View>
  );
}

export default function ResultsScreen({ route, navigation, pace }) {
  const { colors } = useTheme();
  const { system, destinationStopId, destinationName, userLat, userLng } = route.params;
  const [routes, setRoutes] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [mode, setMode] = useState(null);
  const [originName, setOriginName] = useState("Your location");
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);
  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    (async () => {
      try {
        let foundRoutes = false;

        if (userLat && userLng) {
          try {
            const resp = await fetch(`${API_BASE}/api/v1/stops/${system}`, { headers: { "Accept": "application/json" } });
            const data = await resp.json();
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

        if (!foundRoutes) {
          setMode("departures");
          try {
            const depData = await api.departures(system, destinationStopId, { limit: 15 });
            setDepartures(depData.departures || []);
          } catch {
            try {
              const stopsData = await api.departureStops(system);
              const match = (stopsData.stops || []).find((s) => s.includes(destinationStopId) || destinationStopId.includes(s));
              if (match) {
                const depData = await api.departures(system, match, { limit: 15 });
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
  }, [system, destinationStopId, userLat, userLng, pace]);

  const systemName = { mta: "MTA", mbta: "MBTA", cta: "CTA", septa: "SEPTA" }[system] || system;

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.textMuted} />
        <Text style={{ color: colors.textSecondary, fontSize: 15, marginTop: 16, letterSpacing: 0.2 }}>Finding routes...</Text>
      </View>
    );
  }

  // Filter relevant alerts
  const routeIds = new Set([
    ...routes.flatMap((r) => r.legs?.filter((l) => l.routeId).map((l) => l.routeId) || []),
    ...departures.map((d) => d.routeId).filter(Boolean),
  ]);
  const relevantAlerts = alerts.filter((a) => a.routeIds?.some((r) => routeIds.has(r))).slice(0, 2);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 50 }}>
        <Animated.View style={{ opacity: fadeIn }}>

          {/* Header */}
          {mode === "planner" ? (
            <View style={{ marginBottom: 24 }}>
              <Text style={{ fontSize: 13, color: colors.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>FROM</Text>
              <Text style={{ fontSize: 17, color: colors.textSecondary, fontWeight: "500", marginBottom: 16, letterSpacing: 0.1 }}>{originName}</Text>
              <Text style={{ fontSize: 13, color: colors.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>TO</Text>
              <Text style={{ fontSize: 26, color: colors.text, fontWeight: "700", letterSpacing: -0.5 }}>{destinationName}</Text>
            </View>
          ) : (
            <View style={{ marginBottom: 24 }}>
              <Text style={{ fontSize: 26, color: colors.text, fontWeight: "700", letterSpacing: -0.5, marginBottom: 6 }}>
                {destinationName}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 14, color: colors.textSecondary }}>{systemName}</Text>
                <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textMuted }} />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
                  <Text style={{ fontSize: 12, color: colors.green, fontWeight: "600" }}>Live</Text>
                </View>
              </View>
            </View>
          )}

          {/* Alerts */}
          {relevantAlerts.map((alert, i) => {
            const sc = alert.severity === "severe" ? colors.red : alert.severity === "moderate" ? colors.yellow : colors.blue;
            return (
              <View key={`alert-${i}`} style={{
                padding: 14, borderRadius: radius.lg, marginBottom: 10,
                backgroundColor: sc + "08", borderWidth: 1, borderColor: sc + "20",
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: sc }} />
                  <Text style={{ fontSize: 11, fontWeight: "700", color: sc, textTransform: "uppercase", letterSpacing: 0.8 }}>{alert.type || "alert"}</Text>
                </View>
                <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 19 }} numberOfLines={2}>{alert.headerText}</Text>
              </View>
            );
          })}

          {/* ═══ PLANNER MODE ═══ */}
          {mode === "planner" && routes.length === 0 && (
            <View style={{ alignItems: "center", paddingVertical: 36 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 16, fontWeight: "500" }}>No routes found</Text>
              <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>Try a different destination</Text>
            </View>
          )}

          {mode === "planner" && routes.map((rt, ri) => (
            <View key={rt.id || ri} style={{
              backgroundColor: colors.card, borderRadius: radius.xl, padding: 20,
              marginBottom: 12, borderWidth: 1, borderColor: colors.cardBorder,
            }}>
              {/* Time + probability */}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                  <Text style={{ fontSize: 28, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: -1 }}>
                    {rt.totalTimeMin}
                  </Text>
                  <Text style={{ fontSize: 14, color: colors.textSecondary, marginLeft: 2 }}>min</Text>
                  {rt.transfers > 0 && (
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginLeft: 10 }}>
                      {rt.transfers} transfer{rt.transfers > 1 ? "s" : ""}
                    </Text>
                  )}
                </View>
                <ProbBadge probability={rt.overallProbability} />
              </View>

              {/* Leg visualization */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {rt.legs.map((leg, li) => {
                  if (leg.type === "walk") return (
                    <View key={`w-${li}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Text style={{ fontSize: 14 }}>🚶</Text>
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>{leg.durationMin}m</Text>
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
                        <View style={{
                          paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
                          backgroundColor: pc + "12", borderWidth: 1, borderColor: pc + "25",
                        }}>
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

              {/* Transfer station name */}
              {rt.legs.filter((l) => l.type === "transfer").map((leg, i) => (
                <Text key={`ts-${i}`} style={{ fontSize: 12, color: colors.textMuted, marginTop: 10 }}>
                  Transfer at {leg.station}
                </Text>
              ))}

              {/* Leave by */}
              {rt.leaveBy && (
                <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
                  Leave by {new Date(rt.leaveBy).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </Text>
              )}
            </View>
          ))}

          {/* ═══ DEPARTURES MODE ═══ */}
          {mode === "departures" && departures.length === 0 && (
            <View style={{ alignItems: "center", paddingVertical: 36 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 16, fontWeight: "500" }}>No departures right now</Text>
              <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>This station may not have active service</Text>
            </View>
          )}

          {mode === "departures" && departures.map((dep, i) => (
            <View key={`${dep.tripId}-${i}`} style={{
              flexDirection: "row", alignItems: "center", justifyContent: "space-between",
              paddingVertical: 16,
              borderBottomWidth: i < departures.length - 1 ? 1 : 0,
              borderBottomColor: colors.cardBorder,
            }}>
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

              <View style={{ alignItems: "flex-end", minWidth: 60 }}>
                <TickingCountdown departureTime={dep.departureTime} />
                {dep.delay && dep.delay > 0 ? (
                  <Text style={{ fontSize: 10, color: colors.yellow, fontWeight: "600", marginTop: 2 }}>
                    +{Math.round(dep.delay / 60)}m late
                  </Text>
                ) : null}
              </View>
            </View>
          ))}

          {/* View departures link for planner mode */}
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
