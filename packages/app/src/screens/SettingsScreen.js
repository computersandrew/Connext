// src/screens/SettingsScreen.js
import { useState, useEffect } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, spacing, fontSize, radius } from "../theme";
import { api, API_BASE } from "../services/api";

export default function SettingsScreen() {
  const [health, setHealth] = useState(null);
  const [name, setName] = useState("");
  const [pace, setPace] = useState("");

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
    AsyncStorage.getItem("connext_name").then((n) => n && setName(n));
    AsyncStorage.getItem("connext_pace").then((p) => p && setPace(p));
  }, []);

  const activeSystems = health?.systems
    ? Object.entries(health.systems).filter(([, s]) => s.status === "running")
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>

        {/* Profile */}
        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.2, color: colors.textMuted, marginBottom: 8, marginTop: 8 }}>
          Profile
        </Text>
        <View style={{ backgroundColor: colors.card, borderRadius: radius.md, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: colors.cardBorder }}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>{name}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
            Walking pace: {pace}
          </Text>
        </View>

        {/* Server */}
        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.2, color: colors.textMuted, marginBottom: 8 }}>
          Server
        </Text>
        <View style={{ backgroundColor: colors.card, borderRadius: radius.md, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: colors.cardBorder }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{API_BASE}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: health ? colors.green : colors.yellow }} />
              <Text style={{ color: health ? colors.green : colors.textMuted, fontSize: 12, fontWeight: "500" }}>
                {health ? "Connected" : "..."}
              </Text>
            </View>
          </View>
        </View>

        {/* Active systems */}
        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.2, color: colors.textMuted, marginBottom: 8 }}>
          Active Systems
        </Text>
        {activeSystems.map(([id, sys]) => (
          <View key={id} style={{
            flexDirection: "row", alignItems: "center", justifyContent: "space-between",
            paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.cardBorder,
          }}>
            <Text style={{ color: colors.text, fontSize: 14 }}>{sys.config?.name || id}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>{sys.config?.city}</Text>
          </View>
        ))}

        {/* About */}
        <View style={{ marginTop: 32, alignItems: "center" }}>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>conneXt v1.0.0</Text>
        </View>
      </ScrollView>
    </View>
  );
}
