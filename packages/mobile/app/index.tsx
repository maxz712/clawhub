import { useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Link } from "expo-router";

interface Change { id: string; branch: string; intent: string; status: string; risk: string }

export default function Home() {
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const token = await SecureStore.getItemAsync("clawhub_token");
      const base = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "https://clawhub.dev";
      const res = await fetch(`${base}/api/v1/repos`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const data = await res.json() as { repos: Array<{ id: string; name: string; namespaceId: string }> };
      const all: Change[] = [];
      for (const r of data.repos.slice(0, 3)) {
        const c = await fetch(`${base}/api/v1/repos/${r.namespaceId}/${r.name}/changes`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        const j = await c.json() as { changes: Change[] };
        all.push(...j.changes.slice(0, 5));
      }
      setChanges(all);
    } catch (e) {
      // surface via state in a real app
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  return (
    <FlatList
      data={changes}
      keyExtractor={i => i.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#00e5a0" />}
      ListHeaderComponent={<View style={styles.header}><Text style={styles.title}>Changes</Text></View>}
      ListEmptyComponent={!loading ? <Text style={styles.empty}>No changes. Pull to refresh.</Text> : null}
      renderItem={({ item }) => (
        <Link href={{ pathname: "/change/[id]", params: { id: item.id } }} asChild>
          <TouchableOpacity style={styles.row}>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 4 }}>
              <Text style={[styles.badge, styles.risk, riskStyle(item.risk)]}>{item.risk}</Text>
              <Text style={[styles.badge, styles.status]}>{item.status}</Text>
              <Text style={styles.branch}>{item.branch}</Text>
            </View>
            <Text style={styles.intent}>{item.intent}</Text>
          </TouchableOpacity>
        </Link>
      )}
      style={styles.list}
    />
  );
}

function riskStyle(r: string) {
  if (r === "critical") return { backgroundColor: "rgba(255,95,95,0.15)", color: "#ff5f5f" };
  if (r === "high") return { backgroundColor: "rgba(255,138,61,0.15)", color: "#ff8a3d" };
  if (r === "medium") return { backgroundColor: "rgba(255,215,95,0.15)", color: "#ffd75f" };
  return { backgroundColor: "rgba(0,229,160,0.15)", color: "#00e5a0" };
}

const styles = StyleSheet.create({
  list: { backgroundColor: "#0a0a0c" },
  header: { padding: 16 },
  title: { color: "#e8e8ed", fontSize: 28, fontWeight: "700" },
  empty: { color: "#8888a0", padding: 16 },
  row: { padding: 14, marginHorizontal: 12, marginBottom: 8, backgroundColor: "#16161b", borderColor: "#2a2a33", borderWidth: 1, borderRadius: 10 },
  intent: { color: "#e8e8ed", fontSize: 15 },
  branch: { color: "#8888a0", fontFamily: "Menlo", fontSize: 12, marginLeft: "auto" },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, fontSize: 11, fontFamily: "Menlo", fontWeight: "700", textTransform: "uppercase" },
  risk: {},
  status: { backgroundColor: "rgba(95,158,255,0.15)", color: "#5f9eff" },
});
