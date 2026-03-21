// src/screens/SettingsScreen.js
import { useState, useEffect } from "react";
import { View, Text, ScrollView } from "react-native";
import { colors, spacing, fontSize, radius } from "../theme";
import { api, API_BASE } from "../services/api";
import { Card, SectionLabel, SystemChip } from "../components/ui";

export default function SettingsScreen() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: 20, paddingBottom: 100 }}>
        <Text style={{ fontSize: fontSize.xl, fontWeight: "700", color: colors.text, marginBottom: spacing.lg }}>
          Settings
        </Text>

        <SectionLabel>Server</SectionLabel>
        <Card>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>API Endpoint</Text>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500", marginTop: 2 }}>{API_BASE}</Text>
        </Card>
        <Card>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Status</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
            <View style={{
              width: 8, height: 8, borderRadius: 4,
              backgroundColor: health?.status === "operational" ? colors.green : colors.yellow,
            }} />
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>
              {health?.status === "operational" ? "Connected" : "Checking..."}
            </Text>
          </View>
        </Card>
        {health && (
          <Card>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Redis</Text>
            <Text style={{ color: colors.text, fontSize: 14, marginTop: 2 }}>{health.redis || "unknown"}</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 8 }}>Total Keys</Text>
            <Text style={{ color: colors.text, fontSize: 14, marginTop: 2 }}>{health.totalKeys || 0}</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 8 }}>Uptime</Text>
            <Text style={{ color: colors.text, fontSize: 14, marginTop: 2 }}>
              {health.uptime ? `${Math.round(health.uptime / 60)} min` : "unknown"}
            </Text>
          </Card>
        )}

        <SectionLabel>Systems</SectionLabel>
        {health?.systems && Object.entries(health.systems).map(([id, sys]) => (
          <Card key={id}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }}>{sys.config?.name || id}</Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{sys.config?.city}</Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <View style={{
                  width: 8, height: 8, borderRadius: 4,
                  backgroundColor: sys.status === "running" ? colors.green : sys.status === "stopped" ? colors.yellow : colors.textMuted,
                }} />
                <Text style={{ color: sys.status === "running" ? colors.green : colors.textSecondary, fontSize: 12, fontWeight: "600" }}>
                  {sys.status?.toUpperCase()}
                </Text>
              </View>
            </View>
            {sys.stats && (
              <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 6 }}>
                {sys.stats.fetchCount || 0} fetches · {sys.stats.errorCount || 0} errors · avg {sys.stats.avgFetchMs || 0}ms
              </Text>
            )}
          </Card>
        ))}

        <SectionLabel>About</SectionLabel>
        <Card>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>connext</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>Version 1.0.0</Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 8, lineHeight: 16 }}>
            Modular transit wayfinder with real-time data and connection probability engine.
          </Text>
        </Card>
      </ScrollView>
    </View>
  );
}
