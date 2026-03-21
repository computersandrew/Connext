// App.js
import { useState, useEffect } from "react";
import { View, Text, TextInput, Pressable, StatusBar } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Navigation from "./src/navigation";
import { colors, spacing, fontSize, radius } from "./src/theme";

function OnboardingScreen({ onComplete }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [pace, setPace] = useState("average");

  const paces = [
    { id: "slow", label: "Relaxed", desc: "I take my time", icon: "🚶" },
    { id: "average", label: "Average", desc: "Normal pace", icon: "🚶‍♂️" },
    { id: "fast", label: "Fast", desc: "I walk with purpose", icon: "🏃" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: spacing.xl }}>
      <StatusBar barStyle="light-content" />

      {/* Progress dots */}
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, position: "absolute", top: 60, left: 0, right: 0 }}>
        {[0, 1].map((i) => (
          <View key={i} style={{
            width: step === i ? 24 : 6, height: 6, borderRadius: 3,
            backgroundColor: step === i ? colors.text : colors.cardActive,
          }} />
        ))}
      </View>

      {step === 0 && (
        <>
          <Text style={{
            fontSize: 42, fontWeight: "800", color: colors.text,
            textAlign: "center", letterSpacing: -1, marginBottom: 6,
          }}>conneXt</Text>
          <Text style={{
            fontSize: 14, color: colors.textSecondary, textAlign: "center", marginBottom: 48,
          }}>Your transit, simplified.</Text>

          <Text style={{
            fontSize: 11, fontWeight: "600", textTransform: "uppercase",
            letterSpacing: 1.2, color: colors.textSecondary, marginBottom: 6,
          }}>What should we call you?</Text>

          <TextInput
            style={{
              backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder,
              borderRadius: radius.md, padding: 14, color: colors.text, fontSize: 15,
            }}
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={colors.textMuted}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => name.trim() && setStep(1)}
          />

          <Pressable
            onPress={() => name.trim() && setStep(1)}
            style={{
              backgroundColor: name.trim() ? colors.accent : colors.card,
              borderRadius: radius.md, padding: 14, alignItems: "center",
              marginTop: spacing.lg, opacity: name.trim() ? 1 : 0.4,
            }}
          >
            <Text style={{ color: name.trim() ? colors.bg : colors.textMuted, fontSize: 15, fontWeight: "600" }}>Continue</Text>
          </Pressable>
        </>
      )}

      {step === 1 && (
        <>
          <Text style={{
            fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: 6,
          }}>How do you walk, {name}?</Text>
          <Text style={{
            fontSize: 14, color: colors.textSecondary, marginBottom: 32,
          }}>This helps estimate time to your nearest stop.</Text>

          {paces.map((p) => (
            <Pressable key={p.id} onPress={() => setPace(p.id)} style={{
              flexDirection: "row", alignItems: "center", gap: 14,
              padding: 14, borderRadius: radius.md, marginBottom: 8,
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

          <Pressable
            onPress={() => onComplete(name.trim(), pace)}
            style={{
              backgroundColor: colors.accent, borderRadius: radius.md,
              padding: 14, alignItems: "center", marginTop: spacing.lg,
            }}
          >
            <Text style={{ color: colors.bg, fontSize: 15, fontWeight: "600" }}>Get Started</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export default function App() {
  const [userName, setUserName] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    AsyncStorage.removeItem("connext_name").then(() => {
      setLoading(false);
    });
  }, []);
  const handleOnboarding = async (name, pace) => {
    await AsyncStorage.setItem("connext_name", name);
    await AsyncStorage.setItem("connext_pace", pace || "average");
    setUserName(name);
  };
  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  if (!userName) return <OnboardingScreen onComplete={handleOnboarding} />;

  return (
    <>
      <StatusBar barStyle="light-content" />
      <Navigation userName={userName} />
    </>
  );
}
