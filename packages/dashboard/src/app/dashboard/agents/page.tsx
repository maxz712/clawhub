"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getStoredUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot, Plus, Loader2 } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  type?: string;
  status?: string;
  created_at?: string;
  api_key?: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("code_assistant");
  const [newAgentKey, setNewAgentKey] = useState<string | null>(null);

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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");
    setCreating(true);
    setNewAgentKey(null);

    try {
      const user = getStoredUser();
      const ownerId = (user?.id as string) || "";
      const data = await api.registerAgent(newName, newType, ownerId);
      if (data.token) {
        setNewAgentKey(data.token);
      } else {
        setDialogOpen(false);
        setNewName("");
        setNewType("code_assistant");
      }
      loadAgents();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to register agent"
      );
    } finally {
      setCreating(false);
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
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground mt-1">
            Manage registered AI agents
          </p>
        </div>

        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) {
              setNewAgentKey(null);
              setNewName("");
              setNewType("code_assistant");
              setCreateError("");
            }
          }}
        >
          <DialogTrigger render={<Button />}>
            <Plus className="h-4 w-4 mr-2" />
            Register Agent
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Register New Agent</DialogTitle>
            </DialogHeader>

            {newAgentKey ? (
              <div className="space-y-4">
                <Alert>
                  <AlertDescription>
                    Agent registered successfully. Save this API key -- it won&apos;t
                    be shown again.
                  </AlertDescription>
                </Alert>
                <div className="space-y-2">
                  <Label>API Key</Label>
                  <div className="p-3 bg-muted/30 rounded-md font-mono text-sm break-all select-all">
                    {newAgentKey}
                  </div>
                </div>
                <Button
                  className="w-full"
                  onClick={() => {
                    setDialogOpen(false);
                    setNewAgentKey(null);
                    setNewName("");
                    setNewType("code_assistant");
                  }}
                >
                  Done
                </Button>
              </div>
            ) : (
              <form onSubmit={handleCreate} className="space-y-4">
                {createError && (
                  <Alert variant="destructive">
                    <AlertDescription>{createError}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    id="agent-name"
                    placeholder="my-code-agent"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-type">Type</Label>
                  <Select value={newType} onValueChange={(v) => { if (v) setNewType(v); }}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="code_assistant">
                        Code Assistant
                      </SelectItem>
                      <SelectItem value="code_reviewer">
                        Code Reviewer
                      </SelectItem>
                      <SelectItem value="test_generator">
                        Test Generator
                      </SelectItem>
                      <SelectItem value="refactorer">Refactorer</SelectItem>
                      <SelectItem value="security_scanner">
                        Security Scanner
                      </SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={creating}>
                    {creating && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Register
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
            <h3 className="text-lg font-medium mb-1">No agents registered</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Register an AI agent to start submitting code changes
            </p>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Register Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-card border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                      {agent.name}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="capitalize text-sm text-muted-foreground">
                      {(agent.type || "unknown").replace(/_/g, " ")}
                    </span>
                  </TableCell>
                  <TableCell>
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
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {agent.created_at
                      ? new Date(agent.created_at).toLocaleDateString()
                      : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
