import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

export default function ChangeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<{ change: { intent: string; risk: string; status: string; branch: string; scope: string[] } } | null>(null);

  useEffect(() => {
    void (async () => {
      const token = await SecureStore.getItemAsync("clawhub_token");
      const base = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "https://api.useclawhub.com";
      // NOTE: the API wants ns/repo/id; this mobile stub approximates by fetching from the first matching repo.
      // Production would pass the full triple via params.
      const res = await fetch(`${base}/api/v1/repos`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const repos = (await res.json() as { repos: Array<{ name: string; namespaceId: string }> }).repos;
      for (const r of repos) {
        const c = await fetch(`${base}/api/v1/repos/${r.namespaceId}/${r.name}/changes/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        if (c.ok) { setData(await c.json()); break; }
      }
    })();
  }, [id]);

  if (!data) return <View style={s.wrap}><Text style={s.text}>Loading…</Text></View>;
  return (
    <ScrollView style={s.wrap}>
      <Text style={s.title}>{data.change.intent}</Text>
      <Text style={s.meta}>Risk: {data.change.risk} · Status: {data.change.status}</Text>
      <Text style={s.meta}>Branch: {data.change.branch}</Text>
      <Text style={[s.meta, { marginTop: 16 }]}>Scope</Text>
      {data.change.scope.map(p => <Text key={p} style={s.mono}>  {p}</Text>)}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: "#0a0a0c", padding: 16, flex: 1 },
  text: { color: "#e8e8ed" },
  title: { color: "#e8e8ed", fontSize: 22, fontWeight: "700" },
  meta: { color: "#8888a0", fontSize: 14, marginTop: 8 },
  mono: { color: "#c0c0d0", fontFamily: "Menlo", fontSize: 13 },
});
