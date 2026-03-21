// src/screens/HomeScreen.js
import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, RefreshControl } from "react-native";
import { colors, spacing, fontSize, radius, urgencyColor } from "../theme";
import { api, connectAlertStream } from "../services/api";
import { Card, SectionLabel, SystemChip, LinePill, Badge, EmptyState, LoadingScreen } from "../components/ui";

const SYSTEMS = [
  { id: "mta", name: "MTA", city: "New York" },
  { id: "mbta", name: "MBTA", city: "Boston" },
  { id: "cta", name: "CTA", city: "Chicago" },
  { id: "septa", name: "SEPTA", city: "Philadelphia" },
];

function getGreeting(name) {
  const h = new Date().getHours();
  if (h < 12) return `Morning, ${name}`;
  if (h < 17) return `Afternoon, ${name}`;
  return `Evening, ${name}`;
}

export default function HomeScreen({ navigation, route }) {
  const userName = route.params?.name || "Rider";
  const [system, setSystem] = useState("mta");
  const [alerts, setAlerts] = useState([]);
  const [stops, setStops] = useState([]);
  const [health, setHealth] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [alertData, stopsData, healthData] = await Promise.allSettled([
        api.alertsBySystem(system),
        api.departureStops(system),
        api.health(),
      ]);

      if (alertData.status === "fulfilled") setAlerts(alertData.value.alerts || []);
      if (stopsData.status === "fulfilled") setStops((stopsData.value.stops || []).slice(0, 8));
      if (healthData.status === "fulfilled") setHealth(healthData.value);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [system]);

  useEffect(() => { loadData(); }, [loadData]);

  // Alert WebSocket
  useEffect(() => {
    const ws = connectAlertStream([system], (data) => {
      if (data.alerts?.[system]) setAlerts(data.alerts[system]);
    });
    return () => ws.close();
  }, [system]);

  const onRefresh = () => { setRefreshing(true); loadData(); };

  if (loading) return <LoadingScreen message="Loading transit data..." />;

  const sysInfo = SYSTEMS.find((s) => s.id === system);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 60, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
      >
        {/* Greeting */}
        <Text style={{ fontSize: fontSize.xxl, fontWeight: "700", color: colors.text, letterSpacing: -0.5 }}>
          {getGreeting(userName)}
        </Text>
        <Text style={{ fontSize: fontSize.md - 1, color: colors.textSecondary, marginTop: 4 }}>
          {sysInfo?.name} · {sysInfo?.city}
        </Text>

        {/* Search bar */}
        <Pressable
          onPress={() => navigation.navigate("Search", { system })}
          style={{
            marginTop: spacing.lg, backgroundColor: colors.card, borderRadius: radius.lg,
            padding: 14, flexDirection: "row", alignItems: "center", gap: 12,
            borderWidth: 1, borderColor: colors.cardBorder,
          }}
        >
          <Text style={{ fontSize: 18 }}>🔍</Text>
          <Text style={{ color: colors.textMuted, fontSize: 15 }}>Where are you going?</Text>
        </Pressable>

        {/* System chips */}
        <SectionLabel>Transit System</SectionLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {SYSTEMS.map((s) => (
            <SystemChip key={s.id} label={s.name} active={system === s.id}
              onPress={() => { setSystem(s.id); setLoading(true); }} />
          ))}
        </ScrollView>

        {/* Alerts */}
        {alerts.length > 0 && (
          <>
            <SectionLabel>Disruptions</SectionLabel>
            {alerts.slice(0, 3).map((alert, i) => {
              const sevColor = alert.severity === "severe" ? colors.red : alert.severity === "moderate" ? colors.yellow : colors.blue;
              return (
                <Card key={`alert-${i}`}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Badge text={alert.type?.toUpperCase() || "ALERT"} color={sevColor} />
                    {alert.routeNames?.[0] && (
                      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{alert.routeNames[0]}</Text>
                    )}
                  </View>
                  <Text style={{ color: colors.textSecondary, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
                    {alert.headerText || alert.descriptionText}
                  </Text>
                </Card>
              );
            })}
          </>
        )}

        {/* Quick stops */}
        {stops.length > 0 && (
          <>
            <SectionLabel>Nearby Stops</SectionLabel>
            {stops.map((stop) => (
              <Card key={stop} onPress={() => navigation.navigate("Departures", { system, stop })}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>{stop}</Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                  Tap for live departures →
                </Text>
              </Card>
            ))}
          </>
        )}

        {stops.length === 0 && alerts.length === 0 && (
          <EmptyState icon="🚇" title="No live data yet" subtitle={`${sysInfo?.name} data may still be loading`} />
        )}
      </ScrollView>
    </View>
  );
}
