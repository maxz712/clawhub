"use client";

import { ActivityFeed } from "@/components/activity-feed";

export default function FeedPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Activity</h1>
        <p className="text-muted-foreground mt-1">Live stream of changes, reviews, and CI runs across your repos.</p>
      </div>
      <ActivityFeed />
    </div>
  );
}
