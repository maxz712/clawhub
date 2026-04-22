import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: "#0a0a0c" },
      headerTintColor: "#e8e8ed",
      contentStyle: { backgroundColor: "#0a0a0c" },
    }} />
  );
}
