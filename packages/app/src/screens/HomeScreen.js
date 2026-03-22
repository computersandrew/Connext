// src/screens/HomeScreen.js
import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, TextInput, Pressable, Keyboard, ActivityIndicator } from "react-native";
import { colors, spacing, fontSize, radius } from "../theme";
import { api } from "../services/api";
import { getLocation, detectSystem, SYSTEM_REGIONS } from "../services/location";

function getGreeting(name) {
  const h = new Date().getHours();
  if (h < 5) return `Late night, ${name}`;
  if (h < 12) return `Morning, ${name}`;
  if (h < 17) return `Afternoon, ${name}`;
  if (h < 21) return `Evening, ${name}`;
  return `Night, ${name}`;
}

export default function HomeScreen({ navigation, userName, pace }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [detectedSystem, setDetectedSystem] = useState(null);
  const [locLoading, setLocLoading] = useState(true);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Detect location + system on mount
  useEffect(() => {
    (async () => {
      const loc = await getLocation();
      if (loc) {
        setUserLocation(loc);
        const sys = detectSystem(loc.lat, loc.lng);
        setDetectedSystem(sys);
      }
      setLocLoading(false);
    })();
  }, []);

  // Debounced search
  const doSearch = useCallback(async (q) => {
    if (q.length < 2) { setSuggestions([]); setSearching(false); return; }
    setSearching(true);
    try {
      let results = [];
      if (detectedSystem) {
        // Search only within detected system
        const data = await api.searchStops(detectedSystem.id, q);
        results = (data.stops || []).map((s) => ({ system: detectedSystem.id, ...s }));
      } else {
        // No system detected — search all
        results = await api.searchAllStops(q);
      }
      // Sort: prefix matches first
      results.sort((a, b) => {
        const aP = a.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
        const bP = b.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
        if (aP !== bP) return aP - bP;
        return a.name.localeCompare(b.name);
      });
      setSuggestions(results.slice(0, 12));
    } catch {
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }, [detectedSystem]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(() => doSearch(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, doSearch]);

  const handleSelect = (item) => {
    Keyboard.dismiss();
    setQuery("");
    setSuggestions([]);
    setFocused(false);
    navigation.navigate("Results", {
      system: item.system,
      destinationStopId: item.stopId,
      destinationName: item.name,
      userLat: userLocation?.lat,
      userLng: userLocation?.lng,
      pace,
    });
  };

  const systemLabel = { mta: "MTA", mbta: "MBTA", cta: "CTA", septa: "SEPTA" };
  const systemDot = { mta: "#EE352E", mbta: "#DA291C", cta: "#00A1DE", septa: "#F58220" };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Pressable
        style={{
          flex: 1, padding: spacing.lg,
          justifyContent: focused ? "flex-start" : "center",
          paddingTop: focused ? 60 : 0,
        }}
        onPress={Keyboard.dismiss}
      >
        {/* Settings gear */}
        <Pressable
          onPress={() => navigation.navigate("Settings")}
          style={{ position: "absolute", top: 56, right: spacing.lg, padding: 8, zIndex: 10 }}
        >
          <Text style={{ fontSize: 20, color: colors.textMuted }}>⚙️</Text>
        </Pressable>

        {/* Greeting */}
        <Text style={{
          fontSize: focused ? 20 : 30, fontWeight: "700", color: colors.text,
          letterSpacing: -0.5, marginBottom: focused ? 16 : 4,
        }}>
          {getGreeting(userName)}
        </Text>

        {!focused && (
          <Text style={{ fontSize: 15, color: colors.textSecondary, marginBottom: 32 }}>
            Where are you headed?
          </Text>
        )}

        {/* Search input */}
        <View style={{
          backgroundColor: colors.card, borderRadius: radius.lg,
          borderWidth: 1, borderColor: focused ? colors.cardActive : colors.cardBorder,
          flexDirection: "row", alignItems: "center", paddingHorizontal: 16,
        }}>
          <Text style={{ fontSize: 16, marginRight: 12, opacity: 0.5 }}>📍</Text>
          <TextInput
            ref={inputRef}
            style={{ flex: 1, color: colors.text, fontSize: 16, paddingVertical: 16 }}
            value={query}
            onChangeText={setQuery}
            placeholder="Search a station..."
            placeholderTextColor={colors.textMuted}
            onFocus={() => setFocused(true)}
            onBlur={() => { if (!query) setFocused(false); }}
            returnKeyType="search"
            autoCorrect={false}
          />
          {searching && <ActivityIndicator size="small" color={colors.textMuted} style={{ marginRight: 8 }} />}
          {query.length > 0 && !searching && (
            <Pressable onPress={() => { setQuery(""); setSuggestions([]); inputRef.current?.focus(); }}>
              <Text style={{ fontSize: 16, color: colors.textMuted, padding: 4 }}>✕</Text>
            </Pressable>
          )}
        </View>

        {/* Detected system badge */}
        {!focused && detectedSystem && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, justifyContent: "center" }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: systemDot[detectedSystem.id] }} />
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              Searching {detectedSystem.name}
            </Text>
          </View>
        )}

        {!focused && !detectedSystem && !locLoading && (
          <View style={{ alignItems: "center", marginTop: 12 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              Searching all systems
            </Text>
          </View>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <View style={{ marginTop: 4 }}>
            {suggestions.map((item, i) => (
              <Pressable
                key={`${item.system}-${item.stopId}-${i}`}
                onPress={() => handleSelect(item)}
                style={{
                  flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                  paddingVertical: 13, paddingHorizontal: 4,
                  borderBottomWidth: i < suggestions.length - 1 ? 1 : 0,
                  borderBottomColor: colors.cardBorder,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 15, flex: 1 }} numberOfLines={1}>
                  {item.name}
                </Text>
                {!detectedSystem && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 12 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: systemDot[item.system] }} />
                    <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: "500" }}>{systemLabel[item.system]}</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        )}

        {focused && query.length >= 2 && !searching && suggestions.length === 0 && (
          <View style={{ alignItems: "center", marginTop: 24 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>No stations found</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
