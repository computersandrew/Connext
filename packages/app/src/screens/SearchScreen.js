// src/screens/SearchScreen.js
import { useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { colors, spacing, fontSize, radius } from "../theme";
import { api } from "../services/api";
import { Card, SystemChip } from "../components/ui";

const SYSTEMS = [
  { id: "mta", name: "MTA" },
  { id: "mbta", name: "MBTA" },
  { id: "cta", name: "CTA" },
  { id: "septa", name: "SEPTA" },
];

export default function SearchScreen({ navigation, route }) {
  const [system, setSystem] = useState(route.params?.system || "mta");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const data = await api.departureStops(system);
      const stops = data.stops || [];
      const q = query.toLowerCase();
      const filtered = stops.filter((s) => s.toLowerCase().includes(q)).slice(0, 20);
      setResults(filtered);
    } catch (err) {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: 20, paddingBottom: 100 }}>
        <Text style={{ fontSize: fontSize.xl, fontWeight: "700", color: colors.text, marginBottom: spacing.lg }}>
          Find a Stop
        </Text>

        {/* System chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
          {SYSTEMS.map((s) => (
            <SystemChip key={s.id} label={s.name} active={system === s.id}
              onPress={() => { setSystem(s.id); setResults([]); }} />
          ))}
        </ScrollView>

        {/* Search input */}
        <View style={{
          backgroundColor: colors.card, borderRadius: radius.md,
          borderWidth: 1, borderColor: colors.cardBorder,
          flexDirection: "row", alignItems: "center", paddingHorizontal: 16,
        }}>
          <Text style={{ fontSize: 16, marginRight: 10 }}>🔍</Text>
          <TextInput
            style={{
              flex: 1, color: colors.text, fontSize: 15, paddingVertical: 14,
              fontFamily: undefined,
            }}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={search}
            placeholder="Search stop ID or name..."
            placeholderTextColor={colors.textMuted}
            returnKeyType="search"
            autoFocus
          />
        </View>

        <Pressable onPress={search} style={{
          backgroundColor: colors.accent, borderRadius: radius.md,
          padding: 14, alignItems: "center", marginTop: spacing.md,
        }}>
          {searching ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={{ color: colors.bg, fontSize: 15, fontWeight: "600" }}>Search</Text>
          )}
        </Pressable>

        {/* Results */}
        {results.length > 0 && (
          <View style={{ marginTop: spacing.lg }}>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm, marginBottom: spacing.sm }}>
              {results.length} stops found
            </Text>
            {results.map((stop) => (
              <Card key={stop} onPress={() => navigation.navigate("Departures", { system, stop })}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>{stop}</Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                  {system.toUpperCase()} · Tap for departures →
                </Text>
              </Card>
            ))}
          </View>
        )}

        {results.length === 0 && query.length > 0 && !searching && (
          <View style={{ alignItems: "center", marginTop: spacing.xxl }}>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.md }}>No stops found for "{query}"</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
