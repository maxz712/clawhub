"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AttentionCard, type AttentionItem } from "@/components/attention-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Bell } from "lucide-react";

export default function AttentionPage() {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadItems = () => {
    setLoading(true);
    api
      .getAttentionItems()
      .then((data) => {
        const list = Array.isArray(data) ? data : data.items || data.attention || [];
        setItems(list);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadItems();
  }, []);

  const handleApprove = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item?.repo_id || !item?.change_id) return;

    setActionLoading(id);
    try {
      await api.approveChange(item.repo_id, item.change_id);
      await api.mergeChange(item.repo_id, item.change_id);
      loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item?.repo_id || !item?.change_id) return;

    setActionLoading(id);
    try {
      await api.rejectChange(item.repo_id, item.change_id);
      loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Bell className="h-6 w-6 text-muted-foreground" />
          Needs Your Attention
        </h1>
        <p className="text-muted-foreground mt-1">
          Items that specifically need human judgment. Not a review queue -- just the decisions only you can make.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        <div className="text-center py-20">
          <Bell className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-30" />
          <h3 className="text-lg font-medium mb-1">Nothing needs your attention</h3>
          <p className="text-sm text-muted-foreground">
            Your agents are handling everything. Check back later or browse the activity stream.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <AttentionCard
              key={item.id}
              item={item}
              onApprove={actionLoading ? undefined : handleApprove}
              onReject={actionLoading ? undefined : handleReject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
