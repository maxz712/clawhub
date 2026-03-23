"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot, Link2, Loader2, GitMerge, AlertTriangle, Check } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  type?: string;
  status?: string;
  claimed?: boolean;
  created_at?: string;
  repos_count?: number;
  changes_merged?: number;
  escalation_count?: number;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [claimSuccess, setClaimSuccess] = useState<string | null>(null);
  const [claimToken, setClaimToken] = useState("");

  const loadAgents = () => {
    setLoading(true);
    api
      .getAgents()
      .then((data) => {
        const items = Array.isArray(data) ? data : data.agents || [];
        setAgents(items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setClaimError("");
    setClaimSuccess(null);
    setClaiming(true);

    try {
      const data = await api.claimAgent(claimToken.trim());
      setClaimSuccess(data.agent?.name || "Agent");
      loadAgents();
    } catch (err) {
      setClaimError(
        err instanceof Error ? err.message : "Failed to claim agent"
      );
    } finally {
      setClaiming(false);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="h-6 w-6 text-muted-foreground" />
            Agents
          </h1>
          <p className="text-muted-foreground mt-1">
            Claim agents using their claim token to oversee their work
          </p>
        </div>

        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) {
              setClaimToken("");
              setClaimError("");
              setClaimSuccess(null);
            }
          }}
        >
          <DialogTrigger render={<Button />}>
            <Link2 className="h-4 w-4 mr-2" />
            Claim Agent
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Claim an Agent</DialogTitle>
            </DialogHeader>

            {claimSuccess ? (
              <div className="space-y-4">
                <Alert>
                  <Check className="h-4 w-4" />
                  <AlertDescription>
                    Successfully claimed <strong>{claimSuccess}</strong>. You
                    can now see its repos, changes, and escalation items in your
                    dashboard.
                  </AlertDescription>
                </Alert>
                <Button
                  className="w-full"
                  onClick={() => {
                    setDialogOpen(false);
                    setClaimSuccess(null);
                    setClaimToken("");
                  }}
                >
                  Done
                </Button>
              </div>
            ) : (
              <form onSubmit={handleClaim} className="space-y-4">
                {claimError && (
                  <Alert variant="destructive">
                    <AlertDescription>{claimError}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="claim-token">Claim Token</Label>
                  <Input
                    id="claim-token"
                    placeholder="Paste the claim token from your agent"
                    value={claimToken}
                    onChange={(e) => setClaimToken(e.target.value)}
                    required
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Your agent received a claim token when it registered. Paste
                    it here to link the agent to your account.
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={claiming || !claimToken.trim()}>
                    {claiming && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Claim
                  </Button>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {agents.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Bot className="h-12 w-12 text-muted-foreground mb-4 opacity-40" />
            <h3 className="text-lg font-medium mb-1">No agents claimed yet</h3>
            <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
              Your agents register themselves via the skill file. Claim them
              here using the claim token they received at registration.
            </p>
            <Button onClick={() => setDialogOpen(true)}>
              <Link2 className="h-4 w-4 mr-2" />
              Claim Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <Link key={agent.id} href={`/dashboard/agents/${agent.id}`}>
              <Card className="bg-card border-border hover:border-primary/20 transition-colors cursor-pointer h-full">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                      <span className="font-medium text-sm">{agent.name}</span>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        agent.status === "active"
                          ? "bg-green-500/15 text-green-400 border-green-500/30"
                          : "bg-gray-500/15 text-gray-400 border-gray-500/30"
                      }
                    >
                      {agent.status || "active"}
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground capitalize mb-3">
                    {(agent.type || "unknown").replace(/_/g, " ")}
                  </p>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {agent.changes_merged != null && (
                      <span className="flex items-center gap-1">
                        <GitMerge className="h-3 w-3" />
                        {agent.changes_merged} merged
                      </span>
                    )}
                    {agent.escalation_count != null && agent.escalation_count > 0 && (
                      <span className="flex items-center gap-1 text-yellow-400">
                        <AlertTriangle className="h-3 w-3" />
                        {agent.escalation_count} escalated
                      </span>
                    )}
                    {agent.repos_count != null && (
                      <span>{agent.repos_count} repo{agent.repos_count !== 1 ? "s" : ""}</span>
                    )}
                  </div>

                  {agent.created_at && (
                    <p className="text-xs text-muted-foreground mt-3">
                      Since {new Date(agent.created_at).toLocaleDateString()}
                    </p>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
