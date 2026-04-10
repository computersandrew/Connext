// src/screens/HomeScreen.js
import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, TextInput, Pressable, Keyboard, ActivityIndicator, Animated, LayoutAnimation, Platform, UIManager } from "react-native";
import { useTheme, spacing, fontSize, radius } from "../theme";
import { api } from "../services/api";
import { getLocation, detectSystem } from "../services/location";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function getGreeting(name) {
  const h = new Date().getHours();
  if (h < 5) return `Late night, ${name}`;
  if (h < 12) return `Morning, ${name}`;
  if (h < 17) return `Afternoon, ${name}`;
  if (h < 21) return `Evening, ${name}`;
  return `Night, ${name}`;
}

export default function HomeScreen({ navigation, userName, pace }) {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  const [detectedSystem, setDetectedSystem] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const greetingOpacity = useRef(new Animated.Value(1)).current;
  const greetingScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    (async () => {
      const loc = await getLocation();
      if (loc) {
        setUserLocation(loc);
        const sys = detectSystem(loc.lat, loc.lng);
        setDetectedSystem(sys);
      }
    })();
  }, []);

  // Animate greeting when focused
  useEffect(() => {
    Animated.parallel([
      Animated.timing(greetingScale, { toValue: focused ? 0.75 : 1, duration: 250, useNativeDriver: true }),
      Animated.timing(greetingOpacity, { toValue: focused ? 0.6 : 1, duration: 250, useNativeDriver: true }),
    ]).start();
  }, [focused]);

  const doSearch = useCallback(async (q) => {
    if (q.length < 2) { setSuggestions([]); setSearching(false); return; }
    setSearching(true);
    try {
      let results = [];
      if (detectedSystem) {
        const data = await api.searchStops(detectedSystem.id, q);
        results = (data.stops || []).map((s) => ({ system: detectedSystem.id, ...s }));
      } else {
        results = await api.searchAllStops(q);
      }
      results.sort((a, b) => {
        const aP = a.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
        const bP = b.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
        return aP !== bP ? aP - bP : a.name.localeCompare(b.name);
      });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setSuggestions(results.slice(0, 12));
    } catch {
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }, [detectedSystem]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setSuggestions([]); return; }
    debounceRef.current = setTimeout(() => doSearch(query), 250);
    return () => clearTimeout(debounceRef.current);
  }, [query, doSearch]);

  const handleSelect = (item) => {
    Keyboard.dismiss();
    setQuery("");
    setSuggestions([]);
    setFocused(false);
    navigation.navigate("Results", {
      system: item.system, destinationStopId: item.stopId, destinationName: item.name,
      userLat: userLocation?.lat, userLng: userLocation?.lng, pace,
    });
  };

  const systemLabel = { mta: "MTA", mbta: "MBTA", cta: "CTA", septa: "SEPTA" };
  const systemDot = { mta: "#EE352E", mbta: "#DA291C", cta: "#00A1DE", septa: "#F58220" };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Pressable
        style={{ flex: 1, paddingHorizontal: spacing.xl, justifyContent: focused ? "flex-start" : "center", paddingTop: focused ? 70 : 0 }}
        onPress={Keyboard.dismiss}
      >
        {/* Settings */}
        <Pressable onPress={() => navigation.navigate("Settings")}
          style={{ position: "absolute", top: 58, right: spacing.xl, padding: 8, zIndex: 10 }}>
          <Text style={{ fontSize: 20, color: colors.textMuted }}>⚙️</Text>
        </Pressable>

        {/* Greeting */}
        <Animated.View style={{ opacity: greetingOpacity, transform: [{ scale: greetingScale }], marginBottom: focused ? 20 : 0 }}>
          <Text style={{
            fontSize: 32, fontWeight: "700", color: colors.text,
            letterSpacing: -0.8, marginBottom: 6,
          }}>
            {getGreeting(userName)}
          </Text>
          {!focused && (
            <Text style={{ fontSize: 16, color: colors.textSecondary, letterSpacing: 0.2, marginBottom: 36 }}>
              Where are you headed?
            </Text>
          )}
        </Animated.View>

        {/* Search */}
        <View style={{
          backgroundColor: colors.card, borderRadius: radius.xl,
          borderWidth: 1.5, borderColor: focused ? colors.cardActive : colors.cardBorder,
          flexDirection: "row", alignItems: "center", paddingHorizontal: 18,
        }}>
          <Text style={{ fontSize: 16, marginRight: 12, opacity: 0.4 }}>📍</Text>
          <TextInput
            ref={inputRef}
            style={{ flex: 1, color: colors.text, fontSize: 17, paddingVertical: 18, letterSpacing: 0.2 }}
            value={query} onChangeText={setQuery}
            placeholder="Search a station..." placeholderTextColor={colors.textMuted}
            onFocus={() => setFocused(true)}
            onBlur={() => { if (!query) setFocused(false); }}
            returnKeyType="search" autoCorrect={false}
          />
          {searching && <ActivityIndicator size="small" color={colors.textMuted} style={{ marginRight: 8 }} />}
          {query.length > 0 && !searching && (
            <Pressable onPress={() => { setQuery(""); setSuggestions([]); inputRef.current?.focus(); }} hitSlop={12}>
              <Text style={{ fontSize: 16, color: colors.textMuted }}>✕</Text>
            </Pressable>
          )}
        </View>

        {/* System badge */}
        {!focused && detectedSystem && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 16, justifyContent: "center" }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: systemDot[detectedSystem.id] }} />
            <Text style={{ color: colors.textMuted, fontSize: 12, letterSpacing: 0.3 }}>Searching {detectedSystem.name}</Text>
          </View>
        )}

        {!focused && !detectedSystem && (
          <Text style={{ color: colors.textMuted, fontSize: 12, letterSpacing: 0.3, textAlign: "center", marginTop: 16 }}>
            Searching all systems
          </Text>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <View style={{ marginTop: 8, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.cardBorder, overflow: "hidden" }}>
            {suggestions.map((item, i) => (
              <Pressable
                key={`${item.system}-${item.stopId}-${i}`}
                onPress={() => handleSelect(item)}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                  paddingVertical: 15, paddingHorizontal: 18,
                  backgroundColor: pressed ? colors.cardActive : "transparent",
                  borderBottomWidth: i < suggestions.length - 1 ? 1 : 0,
                  borderBottomColor: colors.cardBorder,
                })}
              >
                <Text style={{ color: colors.text, fontSize: 15, flex: 1, letterSpacing: 0.1 }} numberOfLines={1}>
                  {item.name}
                </Text>
                {!detectedSystem && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 12 }}>
                    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: systemDot[item.system] }} />
                    <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: "500" }}>{systemLabel[item.system]}</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        )}

        {focused && query.length >= 2 && !searching && suggestions.length === 0 && (
          <View style={{ alignItems: "center", marginTop: 32 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 15 }}>No stations found</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
