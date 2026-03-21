// src/navigation/index.js
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { View, Text } from "react-native";
import { colors } from "../theme";

import HomeScreen from "../screens/HomeScreen";
import DeparturesScreen from "../screens/DeparturesScreen";
import SearchScreen from "../screens/SearchScreen";
import AlertsScreen from "../screens/AlertsScreen";
import SettingsScreen from "../screens/SettingsScreen";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function TabIcon({ label, focused }) {
  const icons = { Home: "🏠", Alerts: "⚠️", Settings: "⚙️" };
  return (
    <View style={{ alignItems: "center", gap: 2 }}>
      <Text style={{ fontSize: 20 }}>{icons[label] || "·"}</Text>
      <Text style={{ fontSize: 10, fontWeight: "500", color: focused ? colors.text : colors.textMuted }}>
        {label}
      </Text>
    </View>
  );
}

function HomeTabs({ route }) {
  const name = route.params?.name || "Rider";

  return (
    <Tab.Navigator screenOptions={{
      headerShown: false,
      tabBarStyle: {
        backgroundColor: colors.bg,
        borderTopColor: colors.cardBorder,
        borderTopWidth: 1,
        height: 80,
        paddingTop: 8,
      },
      tabBarShowLabel: false,
    }}>
      <Tab.Screen name="HomeTab" options={{
        tabBarIcon: ({ focused }) => <TabIcon label="Home" focused={focused} />,
      }}>
        {(props) => <HomeScreen {...props} route={{ ...props.route, params: { name } }} />}
      </Tab.Screen>
      <Tab.Screen name="AlertsTab" component={AlertsScreen} options={{
        tabBarIcon: ({ focused }) => <TabIcon label="Alerts" focused={focused} />,
      }} />
      <Tab.Screen name="SettingsTab" component={SettingsScreen} options={{
        tabBarIcon: ({ focused }) => <TabIcon label="Settings" focused={focused} />,
      }} />
    </Tab.Navigator>
  );
}

export default function Navigation({ userName }) {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        contentStyle: { backgroundColor: colors.bg },
      }}>
        <Stack.Screen name="Main" component={HomeTabs}
          initialParams={{ name: userName }}
          options={{ headerShown: false }} />
        <Stack.Screen name="Departures" component={DeparturesScreen}
          options={{ title: "Departures" }} />
        <Stack.Screen name="Search" component={SearchScreen}
          options={{ title: "Find a Stop" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
