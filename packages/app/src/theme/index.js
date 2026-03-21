// src/theme/index.js
export const colors = {
  bg: "#0a0a0b",
  card: "#151518",
  cardBorder: "#1f1f25",
  cardActive: "#2a2a32",
  text: "#e8e8ec",
  textSecondary: "#6b6b76",
  textMuted: "#4a4a56",
  accent: "#e8e8ec",
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
  blue: "#3b82f6",
  amber: "#f59e0b",
};

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
  xl: 20,
  pill: 99,
};

export function confidenceColor(prob) {
  if (prob >= 0.75) return colors.green;
  if (prob >= 0.5) return colors.yellow;
  return colors.red;
}

export function urgencyColor(seconds) {
  if (seconds <= 60) return colors.red;
  if (seconds <= 180) return colors.yellow;
  return colors.text;
}
