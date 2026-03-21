// src/screens/AlertsScreen.js
import { useState, useEffect } from "react";
import { View, Text, ScrollView, RefreshControl } from "react-native";
import { colors, spacing, fontSize } from "../theme";
import { api, connectAlertStream } from "../services/api";
import { Card, SectionLabel, Badge, SystemChip, EmptyState, LoadingScreen } from "../components/ui";

const SYSTEMS = [
  { id: "all", name: "All" },
  { id: "mta", name: "MTA" },
  { id: "mbta", name: "MBTA" },
  { id: "cta", name: "CTA" },
  { id: "septa", name: "SEPTA" },
];

export default function AlertsScreen() {
  const [filter, setFilter] = useState("all");
  const [alertData, setAlertData] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadAlerts = async () => {
    try {
      const data = await api.alerts();
      const alerts = {};
      for (const [sysId, sysData] of Object.entries(data.systems || {})) {
        alerts[sysId] = sysData.alerts || [];
      }
      setAlertData(alerts);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadAlerts(); }, []);

  // Live WebSocket updates
  useEffect(() => {
    const ws = connectAlertStream([], (data) => {
      if (data.alerts) setAlertData(data.alerts);
    });
    return () => ws.close();
  }, []);

  const filteredAlerts = [];
  for (const [sysId, alerts] of Object.entries(alertData)) {
    if (filter !== "all" && filter !== sysId) continue;
    for (const alert of alerts) {
      filteredAlerts.push({ ...alert, _system: sysId });
    }
  }

  if (loading) return <LoadingScreen message="Loading alerts..." />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 20, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAlerts(); }} tintColor={colors.textSecondary} />}
      >
        <Text style={{ fontSize: fontSize.xl, fontWeight: "700", color: colors.text, marginBottom: spacing.lg }}>
          Disruptions
        </Text>

        {/* Filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
          {SYSTEMS.map((s) => (
            <SystemChip key={s.id} label={s.name} active={filter === s.id} onPress={() => setFilter(s.id)} />
          ))}
        </ScrollView>

        {/* Live indicator */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.md }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
          <Text style={{ fontSize: fontSize.xs, color: colors.green, fontWeight: "600" }}>LIVE</Text>
          <Text style={{ fontSize: fontSize.xs, color: colors.textMuted }}>· {filteredAlerts.length} active</Text>
        </View>

        {filteredAlerts.length === 0 ? (
          <EmptyState icon="✅" title="All clear" subtitle="No active disruptions" />
        ) : (
          filteredAlerts.map((alert, i) => {
            const sevColor = alert.severity === "severe" ? colors.red : alert.severity === "moderate" ? colors.yellow : colors.blue;
            return (
              <Card key={`${alert._system}-${alert.alertId}-${i}`} style={{
                borderColor: sevColor + "25",
                backgroundColor: alert.severity === "severe" ? "#1a0a0a" : alert.severity === "moderate" ? "#1a1505" : colors.card,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Badge text={alert.type?.toUpperCase() || "ALERT"} color={sevColor} />
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    {alert._system?.toUpperCase()}
                    {alert.routeNames?.[0] ? ` · ${alert.routeNames[0]}` : ""}
                  </Text>
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: 13, lineHeight: 19 }}>
                  {alert.headerText || alert.descriptionText}
                </Text>
              </Card>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
