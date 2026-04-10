// src/screens/SettingsScreen.js
import { useState, useEffect } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme, spacing, fontSize, radius } from "../theme";
import { api, API_BASE } from "../services/api";

export default function SettingsScreen() {
  const { colors, colorScheme, themePreference, setThemePreference } = useTheme();
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
  const themeOptions = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "auto", label: "Auto" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 50 }}>

        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.5, color: colors.textMuted, marginBottom: 12, marginTop: 8 }}>
          Profile
        </Text>
        <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: 18, marginBottom: 24, borderWidth: 1, borderColor: colors.cardBorder }}>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: "500", letterSpacing: 0.1 }}>{name}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 4 }}>Walking pace: {pace}</Text>
        </View>

        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.5, color: colors.textMuted, marginBottom: 12 }}>
          Appearance
        </Text>
        <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: 6, marginBottom: 24, borderWidth: 1, borderColor: colors.cardBorder }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {themeOptions.map((option) => {
              const selected = themePreference === option.id;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => setThemePreference(option.id)}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    paddingVertical: 12,
                    borderRadius: radius.sm,
                    backgroundColor: selected ? colors.cardActive : "transparent",
                    borderWidth: 1,
                    borderColor: selected ? colors.cardBorder : "transparent",
                  }}
                >
                  <Text style={{ color: selected ? colors.text : colors.textSecondary, fontSize: 14, fontWeight: "600" }}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 10, paddingHorizontal: 6 }}>
            Current mode: {colorScheme}
          </Text>
        </View>

        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.5, color: colors.textMuted, marginBottom: 12 }}>
          Server
        </Text>
        <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, padding: 18, marginBottom: 24, borderWidth: 1, borderColor: colors.cardBorder }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13, flex: 1 }} numberOfLines={1}>{API_BASE}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 12 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: health ? colors.green : colors.yellow }} />
              <Text style={{ color: health ? colors.green : colors.textMuted, fontSize: 12, fontWeight: "600" }}>
                {health ? "Connected" : "..."}
              </Text>
            </View>
          </View>
        </View>

        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.5, color: colors.textMuted, marginBottom: 12 }}>
          Active Systems
        </Text>
        <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden" }}>
          {activeSystems.map(([id, sys], i) => (
            <View key={id} style={{
              flexDirection: "row", alignItems: "center", justifyContent: "space-between",
              paddingVertical: 14, paddingHorizontal: 18,
              borderBottomWidth: i < activeSystems.length - 1 ? 1 : 0,
              borderBottomColor: colors.cardBorder,
            }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>{sys.config?.name || id}</Text>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>{sys.config?.city}</Text>
            </View>
          ))}
          {activeSystems.length === 0 && (
            <View style={{ padding: 18 }}>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>Checking...</Text>
            </View>
          )}
        </View>

        <View style={{ marginTop: 40, alignItems: "center" }}>
          <Text style={{ color: colors.textMuted, fontSize: 12, letterSpacing: 0.3 }}>conneXt v1.0.0</Text>
        </View>
      </ScrollView>
    </View>
  );
}
