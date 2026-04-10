// App.js
import { useState, useEffect, useRef } from "react";
import { View, Text, TextInput, Pressable, StatusBar, Animated } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Navigation from "./src/navigation";
import { ThemeProvider, useTheme, spacing, fontSize, radius } from "./src/theme";

function OnboardingName({ onNext }) {
  const { colors } = useTheme();
  const [name, setName] = useState("");
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: spacing.xl + 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, position: "absolute", top: 60, left: 0, right: 0 }}>
        <View style={{ width: 24, height: 4, borderRadius: 2, backgroundColor: colors.text }} />
        <View style={{ width: 6, height: 4, borderRadius: 2, backgroundColor: colors.cardActive }} />
      </View>

      <Animated.View style={{ opacity: fadeIn, transform: [{ translateY: slideUp }] }}>
        <Text style={{ fontSize: 44, fontWeight: "800", color: colors.text, textAlign: "center", letterSpacing: -1.5, marginBottom: 8 }}>
          conneXt
        </Text>
        <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: "center", marginBottom: 56, letterSpacing: 0.3 }}>
          Your transit, simplified.
        </Text>

        <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.5, color: colors.textMuted, marginBottom: 10 }}>
          What should we call you?
        </Text>
        <TextInput
          style={{
            backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
            borderRadius: radius.lg, paddingHorizontal: 18, paddingVertical: 16,
            color: colors.text, fontSize: 17, letterSpacing: 0.2,
          }}
          value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.textMuted}
          autoFocus returnKeyType="next" onSubmitEditing={() => name.trim() && onNext(name.trim())}
        />

        <Pressable onPress={() => name.trim() && onNext(name.trim())} style={{
          backgroundColor: name.trim() ? colors.accent : colors.card, borderRadius: radius.lg,
          paddingVertical: 16, alignItems: "center", marginTop: 24, opacity: name.trim() ? 1 : 0.4,
        }}>
          <Text style={{ color: name.trim() ? colors.bg : colors.textMuted, fontSize: 16, fontWeight: "600", letterSpacing: 0.3 }}>Continue</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function OnboardingPace({ name, onComplete }) {
  const { colors } = useTheme();
  const [pace, setPace] = useState("average");
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  }, []);

  const paces = [
    { id: "slow", label: "Relaxed", desc: "I take my time", icon: "🚶" },
    { id: "average", label: "Average", desc: "Normal walking pace", icon: "🚶‍♂️" },
    { id: "fast", label: "Fast", desc: "I walk with purpose", icon: "🏃" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: spacing.xl + 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, position: "absolute", top: 60, left: 0, right: 0 }}>
        <View style={{ width: 6, height: 4, borderRadius: 2, backgroundColor: colors.cardActive }} />
        <View style={{ width: 24, height: 4, borderRadius: 2, backgroundColor: colors.text }} />
      </View>

      <Animated.View style={{ opacity: fadeIn, transform: [{ translateY: slideUp }] }}>
        <Text style={{ fontSize: 24, fontWeight: "700", color: colors.text, marginBottom: 8, letterSpacing: -0.5 }}>
          How do you walk, {name}?
        </Text>
        <Text style={{ fontSize: 15, color: colors.textSecondary, marginBottom: 36, letterSpacing: 0.2 }}>
          Helps estimate time to your stop.
        </Text>

        {paces.map((p) => (
          <Pressable key={p.id} onPress={() => setPace(p.id)} style={{
            flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 16, paddingHorizontal: 16,
            borderRadius: radius.lg, marginBottom: 10,
            backgroundColor: pace === p.id ? colors.card : "transparent",
            borderWidth: 1, borderColor: pace === p.id ? colors.cardBorder : "transparent",
          }}>
            <Text style={{ fontSize: 26 }}>{p.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text, letterSpacing: 0.2 }}>{p.label}</Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{p.desc}</Text>
            </View>
            {pace === p.id && (
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.green + "20", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: colors.green, fontSize: 13, fontWeight: "700" }}>✓</Text>
              </View>
            )}
          </Pressable>
        ))}

        <Pressable onPress={() => onComplete(pace)} style={{
          backgroundColor: colors.accent, borderRadius: radius.lg,
          paddingVertical: 16, alignItems: "center", marginTop: 28,
        }}>
          <Text style={{ color: colors.bg, fontSize: 16, fontWeight: "600", letterSpacing: 0.3 }}>Get Started</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function AppContent() {
  const { colors, colorScheme } = useTheme();
  const [userName, setUserName] = useState(null);
  const [pace, setPace] = useState(null);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [tempName, setTempName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("connext_name"),
      AsyncStorage.getItem("connext_pace"),
    ]).then(([name, savedPace]) => {
      if (name) { setUserName(name); setPace(savedPace || "average"); }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleNameDone = (name) => { setTempName(name); setOnboardingStep(1); };
  const handleComplete = async (selectedPace) => {
    await AsyncStorage.setItem("connext_name", tempName);
    await AsyncStorage.setItem("connext_pace", selectedPace);
    setUserName(tempName);
    setPace(selectedPace);
  };

  const statusBarStyle = colorScheme === "dark" ? "light-content" : "dark-content";

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (!userName && onboardingStep === 0) return (<><StatusBar barStyle={statusBarStyle} /><OnboardingName onNext={handleNameDone} /></>);
  if (!userName && onboardingStep === 1) return (<><StatusBar barStyle={statusBarStyle} /><OnboardingPace name={tempName} onComplete={handleComplete} /></>);

  return (<><StatusBar barStyle={statusBarStyle} /><Navigation userName={userName} pace={pace} /></>);
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
