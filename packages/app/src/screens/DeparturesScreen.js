// src/screens/DeparturesScreen.js
import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView } from "react-native";
import { colors, spacing, fontSize, radius, urgencyColor } from "../theme";
import { connectDepartureStream, api } from "../services/api";
import { Card, SectionLabel, LinePill, Badge, EmptyState, LoadingScreen } from "../components/ui";

export default function DeparturesScreen({ route }) {
  const { system, stop } = route.params;
  const [departures, setDepartures] = useState([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);

  useEffect(() => {
    // Initial REST fetch
    api.departures(system, stop, { limit: 15 }).then((data) => {
      setDepartures(data.departures || []);
      setLoading(false);
    }).catch(() => setLoading(false));

    // WebSocket for live updates
    wsRef.current = connectDepartureStream(system, stop, (data) => {
      setDepartures(data.departures || []);
      setLoading(false);
    });

    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [system, stop]);

  if (loading) return <LoadingScreen message="Loading departures..." />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: 20, paddingBottom: 100 }}>
        <Text style={{ fontSize: fontSize.xl, fontWeight: "700", color: colors.text, marginBottom: 4 }}>
          {stop}
        </Text>
        <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.lg }}>
          {system.toUpperCase()} · Live departures
        </Text>

        {/* Live indicator */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.md }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
          <Text style={{ fontSize: fontSize.xs, color: colors.green, fontWeight: "600", letterSpacing: 0.5 }}>
            LIVE · Updates every 5s
          </Text>
        </View>

        {departures.length === 0 ? (
          <EmptyState icon="🕐" title="No departures" subtitle="No upcoming departures found for this stop" />
        ) : (
          departures.map((dep, i) => {
            const secAway = dep.secondsAway;
            const minAway = dep.minutesAway;
            const isImm = secAway !== null && secAway <= 60;
            const isSoon = secAway !== null && secAway <= 180;

            return (
              <Card key={`${dep.tripId}-${i}`} style={{
                borderColor: isImm ? colors.red + "40" : isSoon ? colors.yellow + "30" : colors.cardBorder,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                    <LinePill name={dep.routeName} color={dep.routeColor} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }} numberOfLines={1}>
                        {dep.routeName || dep.routeId}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                        {dep.direction || dep.stopName}
                      </Text>
                    </View>
                  </View>

                  <View style={{ alignItems: "flex-end" }}>
                    {secAway !== null ? (
                      <>
                        {secAway <= 0 ? (
                          <Text style={{ fontSize: 13, fontWeight: "800", color: colors.red, letterSpacing: 1 }}>NOW</Text>
                        ) : (
                          <Text style={{
                            fontSize: isImm ? 22 : 18, fontWeight: "700",
                            color: urgencyColor(secAway),
                            fontVariant: ["tabular-nums"],
                          }}>
                            {minAway}<Text style={{ fontSize: 11, fontWeight: "400", color: colors.textSecondary }}> min</Text>
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text style={{ fontSize: 12, color: colors.textSecondary }}>Scheduled</Text>
                    )}

                    {dep.delay && dep.delay > 0 && (
                      <Text style={{ fontSize: 10, color: colors.yellow, fontWeight: "600", marginTop: 2 }}>
                        +{Math.round(dep.delay / 60)}min late
                      </Text>
                    )}
                  </View>
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
