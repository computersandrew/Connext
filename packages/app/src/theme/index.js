// src/theme/index.js
export const colors = {
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
