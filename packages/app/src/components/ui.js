// src/components/ui.js
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { colors, radius, spacing, fontSize } from "../theme";

export function LinePill({ name, color, size = 28 }) {
  const display = name?.length <= 3 ? name : name?.charAt(0) || "?";
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.3,
      backgroundColor: color || "#888",
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{
        color: "#fff", fontSize: size * 0.4, fontWeight: "700",
      }}>{display}</Text>
    </View>
  );
}

export function Badge({ text, color }) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 5,
      paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10,
      backgroundColor: color + "18",
    }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

export function Card({ children, onPress, active, style }) {
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper onPress={onPress} style={[{
      backgroundColor: active ? colors.card : colors.card,
      borderRadius: radius.lg,
      padding: spacing.md,
      marginBottom: spacing.sm,
      borderWidth: 1,
      borderColor: active ? colors.cardActive : colors.cardBorder,
    }, style]}>
      {children}
    </Wrapper>
  );
}

export function SectionLabel({ children, right }) {
  return (
    <View style={{
      flexDirection: "row", justifyContent: "space-between", alignItems: "center",
      marginTop: spacing.lg, marginBottom: spacing.sm,
    }}>
      <Text style={{
        fontSize: fontSize.xs + 1, fontWeight: "600", textTransform: "uppercase",
        letterSpacing: 1.5, color: colors.textMuted,
      }}>{children}</Text>
      {right}
    </View>
  );
}

export function SystemChip({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={{
      paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill,
      backgroundColor: active ? colors.accent : colors.card,
      borderWidth: active ? 0 : 1, borderColor: colors.cardBorder,
      marginRight: spacing.sm,
    }}>
      <Text style={{
        fontSize: 13, fontWeight: "500",
        color: active ? colors.bg : colors.textSecondary,
      }}>{label}</Text>
    </Pressable>
  );
}

export function EmptyState({ icon, title, subtitle }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: spacing.xxl }}>
      <Text style={{ fontSize: 32, marginBottom: spacing.sm }}>{icon}</Text>
      <Text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: "600", marginBottom: 4 }}>{title}</Text>
      <Text style={{ color: colors.textSecondary, fontSize: fontSize.md, textAlign: "center" }}>{subtitle}</Text>
    </View>
  );
}

export function LoadingScreen({ message }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="large" color={colors.textSecondary} />
      <Text style={{ color: colors.textSecondary, fontSize: fontSize.md, marginTop: spacing.md }}>{message || "Loading..."}</Text>
    </View>
  );
}
