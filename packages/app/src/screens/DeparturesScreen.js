// src/screens/DeparturesScreen.js
import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, Animated } from "react-native";
import { colors, spacing, radius, urgencyColor } from "../theme";
import { connectDepartureStream, api } from "../services/api";

function LinePill({ name, color, size = 28 }) {
  const display = (name || "?").length <= 3 ? name : (name || "?").charAt(0);
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color || "#888", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontSize: size * 0.38, fontWeight: "800" }}>{display}</Text>
    </View>
  );
}

function TickingCountdown({ departureTime }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);

  if (!departureTime) return <Text style={{ fontSize: 12, color: colors.textMuted }}>Sched</Text>;
  const sec = departureTime - now;
  if (sec <= 0) return <Text style={{ fontSize: 15, fontWeight: "800", color: colors.red }}>NOW</Text>;

  const min = Math.floor(sec / 60);
  const remSec = sec % 60;

  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text style={{ fontSize: sec <= 60 ? 24 : 20, fontWeight: "700", color: urgencyColor(sec), fontVariant: ["tabular-nums"] }}>
        {min}:{String(remSec).padStart(2, "0")}
      </Text>
      <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 1 }}>{min === 0 ? "seconds" : "min"}</Text>
    </View>
  );
}

export default function DeparturesScreen({ route }) {
  const { system, stop, stopName } = route.params;
  const [departures, setDepartures] = useState([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);
  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    api.departures(system, stop, { limit: 20 }).then((data) => {
      setDepartures(data.departures || []);
      setLoading(false);
      Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    }).catch(() => setLoading(false));

    wsRef.current = connectDepartureStream(system, stop, (data) => {
      setDepartures(data.departures || []);
      setLoading(false);
    });
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [system, stop]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 50 }}>
        {/* Live indicator */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 20 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
          <Text style={{ fontSize: 12, color: colors.green, fontWeight: "600", letterSpacing: 0.3 }}>LIVE</Text>
          <Text style={{ fontSize: 12, color: colors.textMuted }}>· ticking every second</Text>
        </View>

        {loading ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 15 }}>Loading...</Text>
          </View>
        ) : departures.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 16, fontWeight: "500" }}>No upcoming departures</Text>
          </View>
        ) : (
          <Animated.View style={{ opacity: fadeIn }}>
            {departures.map((dep, i) => (
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
                    <Text style={{ fontSize: 10, color: colors.yellow, fontWeight: "600", marginTop: 2 }}>+{Math.round(dep.delay / 60)}m late</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}
