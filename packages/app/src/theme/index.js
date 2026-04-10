// src/theme/index.js
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const THEME_STORAGE_KEY = "connext_theme";

export const darkColors = {
  bg: "#141419",
  card: "#1c1c24",
  cardBorder: "#26262f",
  cardActive: "#32323e",
  text: "#ededf0",
  textSecondary: "#8a8a99",
  textMuted: "#555566",
  accent: "#ededf0",
  green: "#34d399",
  yellow: "#fbbf24",
  red: "#f87171",
  blue: "#60a5fa",
  amber: "#f59e0b",
  purple: "#a78bfa",
};

export const lightColors = {
  bg: "#f8fafc",
  card: "#ffffff",
  cardBorder: "#d8dee8",
  cardActive: "#e6edf7",
  text: "#151820",
  textSecondary: "#5f6878",
  textMuted: "#8a94a6",
  accent: "#151820",
  green: "#059669",
  yellow: "#b7791f",
  red: "#dc2626",
  blue: "#2563eb",
  amber: "#d97706",
  purple: "#7c3aed",
};

export const colors = darkColors;

const ThemeContext = createContext({
  colors,
  colorScheme: "dark",
  themePreference: "auto",
  setThemePreference: () => {},
});

function resolveColors(colorScheme) {
  return colorScheme === "dark" ? darkColors : lightColors;
}

export function ThemeProvider({ children }) {
  const [themePreference, setThemePreferenceState] = useState("auto");
  const [systemScheme, setSystemScheme] = useState(Appearance.getColorScheme() || "light");

  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((savedTheme) => {
        if (["light", "dark", "auto"].includes(savedTheme)) {
          setThemePreferenceState(savedTheme);
        }
      })
      .catch(() => {});

    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme || "light");
    });

    return () => subscription.remove();
  }, []);

  const setThemePreference = async (nextPreference) => {
    if (!["light", "dark", "auto"].includes(nextPreference)) return;
    setThemePreferenceState(nextPreference);
    await AsyncStorage.setItem(THEME_STORAGE_KEY, nextPreference);
  };

  const colorScheme = themePreference === "auto" ? systemScheme : themePreference;
  const value = useMemo(() => ({
    colors: resolveColors(colorScheme),
    colorScheme,
    themePreference,
    setThemePreference,
  }), [colorScheme, themePreference]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const fontSize = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 28,
  title: 34,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 99,
};

export function confidenceColor(prob, palette = colors) {
  if (prob >= 0.75) return palette.green;
  if (prob >= 0.5) return palette.yellow;
  return palette.red;
}

export function urgencyColor(seconds, palette = colors) {
  if (seconds <= 60) return palette.red;
  if (seconds <= 180) return palette.yellow;
  return palette.text;
}
