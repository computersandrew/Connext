// src/navigation/index.js
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { colors } from "../theme";

import HomeScreen from "../screens/HomeScreen";
import ResultsScreen from "../screens/ResultsScreen";
import DeparturesScreen from "../screens/DeparturesScreen";
import SettingsScreen from "../screens/SettingsScreen";

const Stack = createNativeStackNavigator();

export default function Navigation({ userName, pace }) {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { fontWeight: "600", fontSize: 16 },
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
