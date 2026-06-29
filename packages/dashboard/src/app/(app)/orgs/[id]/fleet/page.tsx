"use client";

import { use } from "react";
import { FleetPane } from "@/components/fleet-pane";

export default function FleetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = use(params);
  return <FleetPane scope={{ kind: "org", orgId }} />;
}
