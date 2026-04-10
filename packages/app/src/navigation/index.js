// src/navigation/index.js
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useTheme } from "../theme";

import HomeScreen from "../screens/HomeScreen";
import ResultsScreen from "../screens/ResultsScreen";
import DeparturesScreen from "../screens/DeparturesScreen";
import SettingsScreen from "../screens/SettingsScreen";

const Stack = createNativeStackNavigator();

export default function Navigation({ userName, pace }) {
  const { colors, colorScheme } = useTheme();
  const baseTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      primary: colors.accent,
      background: colors.bg,
      card: colors.bg,
      text: colors.text,
      border: colors.cardBorder,
    },
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { fontWeight: "600", fontSize: 17, letterSpacing: -0.3 },
        animation: "slide_from_right",
      }}>
        <Stack.Screen name="Home" options={{ headerShown: false }}>
          {(props) => <HomeScreen {...props} userName={userName} pace={pace} />}
        </Stack.Screen>
        <Stack.Screen name="Results" options={{ title: "" }}>
          {(props) => <ResultsScreen {...props} pace={pace} />}
        </Stack.Screen>
        <Stack.Screen name="Departures" component={DeparturesScreen}
          options={({ route }) => ({ title: route.params?.stopName || "Departures" })} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
