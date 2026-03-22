// App.js
import { useState, useEffect } from "react";
import { View, Text, TextInput, Pressable, StatusBar, Keyboard } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
AsyncStorage.clear();
import Navigation from "./src/navigation";
import { colors, spacing, fontSize, radius } from "./src/theme";

function OnboardingName({ onNext }) {
  const [name, setName] = useState("");

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: spacing.xl }}>
      {/* Progress */}
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, position: "absolute", top: 60, left: 0, right: 0 }}>
        <View style={{ width: 24, height: 5, borderRadius: 3, backgroundColor: colors.text }} />
        <View style={{ width: 6, height: 5, borderRadius: 3, backgroundColor: colors.cardActive }} />
      </View>

      <Text style={{ fontSize: 42, fontWeight: "800", color: colors.text, textAlign: "center", letterSpacing: -1, marginBottom: 6 }}>
        conneXt
      </Text>
      <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: "center", marginBottom: 56 }}>
        Your transit, simplified.
      </Text>

      <Text style={{ fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1.2, color: colors.textSecondary, marginBottom: 8 }}>
        What should we call you?
      </Text>
      <TextInput
        style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.md, padding: 14, color: colors.text, fontSize: 16 }}
        value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.textMuted}
        autoFocus returnKeyType="next" onSubmitEditing={() => name.trim() && onNext(name.trim())}
      />
      <Pressable onPress={() => name.trim() && onNext(name.trim())} style={{
        backgroundColor: name.trim() ? colors.accent : colors.card, borderRadius: radius.md,
        padding: 14, alignItems: "center", marginTop: 20, opacity: name.trim() ? 1 : 0.4,
      }}>
        <Text style={{ color: name.trim() ? colors.bg : colors.textMuted, fontSize: 15, fontWeight: "600" }}>Continue</Text>
      </Pressable>
    </View>
  );
}

function OnboardingPace({ name, onComplete }) {
  const [pace, setPace] = useState("average");
  const paces = [
    { id: "slow", label: "Relaxed", desc: "I take my time", icon: "🚶" },
    { id: "average", label: "Average", desc: "Normal pace", icon: "🚶‍♂️" },
    { id: "fast", label: "Fast", desc: "I walk with purpose", icon: "🏃" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: spacing.xl }}>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, position: "absolute", top: 60, left: 0, right: 0 }}>
        <View style={{ width: 6, height: 5, borderRadius: 3, backgroundColor: colors.cardActive }} />
        <View style={{ width: 24, height: 5, borderRadius: 3, backgroundColor: colors.text }} />
      </View>

      <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: 6 }}>
        How do you walk, {name}?
      </Text>
      <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 36 }}>
        Helps estimate time to your stop.
      </Text>

      {paces.map((p) => (
        <Pressable key={p.id} onPress={() => setPace(p.id)} style={{
          flexDirection: "row", alignItems: "center", gap: 14, padding: 14,
          borderRadius: radius.md, marginBottom: 8,
          backgroundColor: pace === p.id ? "#1a1a1f" : "transparent",
          borderWidth: 1, borderColor: pace === p.id ? colors.cardActive : "transparent",
        }}>
          <Text style={{ fontSize: 24 }}>{p.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{p.label}</Text>
            <Text style={{ fontSize: 12, color: colors.textSecondary }}>{p.desc}</Text>
          </View>
          {pace === p.id && <Text style={{ color: colors.green, fontSize: 18 }}>✓</Text>}
        </Pressable>
      ))}

      <Pressable onPress={() => onComplete(pace)} style={{
        backgroundColor: colors.accent, borderRadius: radius.md,
        padding: 14, alignItems: "center", marginTop: 24,
      }}>
        <Text style={{ color: colors.bg, fontSize: 15, fontWeight: "600" }}>Get Started</Text>
      </Pressable>
    </View>
  );
}

export default function App() {
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

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  if (!userName && onboardingStep === 0) return (
    <><StatusBar barStyle="light-content" /><OnboardingName onNext={handleNameDone} /></>
  );

  if (!userName && onboardingStep === 1) return (
    <><StatusBar barStyle="light-content" /><OnboardingPace name={tempName} onComplete={handleComplete} /></>
  );

  return (
    <>
      <StatusBar barStyle="light-content" />
      <Navigation userName={userName} pace={pace} />
    </>
  );
}
