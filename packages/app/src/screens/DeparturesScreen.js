// src/screens/DeparturesScreen.js
import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView } from "react-native";
import { colors, spacing, fontSize, radius, urgencyColor } from "../theme";
import { connectDepartureStream, api } from "../services/api";

function LinePill({ name, color, size = 26 }) {
  const display = name?.length <= 3 ? name : name?.charAt(0) || "?";
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color || "#888", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontSize: size * 0.4, fontWeight: "700" }}>{display}</Text>
    </View>
  );
}

export default function DeparturesScreen({ route }) {
  const { system, stop, stopName } = route.params;
  const [departures, setDepartures] = useState([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);

  useEffect(() => {
    api.departures(system, stop, { limit: 20 }).then((data) => {
      setDepartures(data.departures || []);
      setLoading(false);
    }).catch(() => setLoading(false));

    wsRef.current = connectDepartureStream(system, stop, (data) => {
      setDepartures(data.departures || []);
      setLoading(false);
    });

    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [system, stop]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        {/* Live indicator */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 16 }}>
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.green }} />
          <Text style={{ fontSize: 11, color: colors.green, fontWeight: "600" }}>LIVE</Text>
          <Text style={{ fontSize: 11, color: colors.textMuted }}>· updates every 5s</Text>
        </View>

        {loading ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Loading...</Text>
          </View>
        ) : departures.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>No upcoming departures</Text>
          </View>
        ) : (
          departures.map((dep, i) => {
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
                  {secAway !== null ? (
                    secAway <= 0 ? (
                      <Text style={{ fontSize: 14, fontWeight: "800", color: colors.red }}>NOW</Text>
                    ) : (
                      <Text style={{ fontSize: isImm ? 22 : 18, fontWeight: "700", color: urgencyColor(secAway), fontVariant: ["tabular-nums"] }}>
                        {minAway}<Text style={{ fontSize: 11, fontWeight: "400", color: colors.textSecondary }}> min</Text>
                      </Text>
                    )
                  ) : (
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>Sched</Text>
                  )}
                  {dep.delay && dep.delay > 0 && (
                    <Text style={{ fontSize: 10, color: colors.yellow, fontWeight: "600", marginTop: 1 }}>
                      +{Math.round(dep.delay / 60)}m late
                    </Text>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
