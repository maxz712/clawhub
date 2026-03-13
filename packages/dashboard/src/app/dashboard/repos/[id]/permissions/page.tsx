"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Badge } from "@/components/ui/badge";
import {
  Shield,
  Plus,
  Trash2,
  Loader2,
  ArrowLeft,
  AlertCircle,
} from "lucide-react";

interface PermissionRule {
  id: string;
  agent_id?: string;
  agent_name?: string;
  path_pattern?: string;
  action?: string;
  effect?: string;
  max_risk_level?: string;
  created_at?: string;
}

export default function PermissionsPage() {
  const params = useParams();
  const repoId = params.id as string;

  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  // Form state
  const [pathPattern, setPathPattern] = useState("**/*");
  const [action, setAction] = useState("write");
  const [effect, setEffect] = useState("allow");
  const [maxRisk, setMaxRisk] = useState("medium");

  const loadRules = () => {
    setLoading(true);
    api
      .getPermissions(repoId)
      .then((data) => {
        const items = Array.isArray(data)
          ? data
          : data.rules || data.permissions || [];
        setRules(items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (repoId) loadRules();
  }, [repoId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");
    setCreating(true);

    try {
      await api.createPermission(repoId, {
        path_pattern: pathPattern,
        action,
        effect,
        max_risk_level: maxRisk,
      });
      setDialogOpen(false);
      setPathPattern("**/*");
      setAction("write");
      setEffect("allow");
      setMaxRisk("medium");
      loadRules();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create rule"
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (ruleId: string) => {
    setDeleting(ruleId);
    try {
      await api.deletePermission(repoId, ruleId);
      loadRules();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete rule"
      );
    } finally {
      setDeleting(null);
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
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/repos" className="hover:text-foreground">
          Repositories
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/repos/${repoId}`}
          className="hover:text-foreground"
        >
          Repo
        </Link>
        <span>/</span>
        <span className="text-foreground">Permissions</span>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="h-6 w-6 text-muted-foreground" />
            Permission Rules
          </h1>
          <p className="text-muted-foreground mt-1">
            Control what AI agents can do in this repository
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link href={`/dashboard/repos/${repoId}`}>
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button />}>
              <Plus className="h-4 w-4 mr-2" />
              Add Rule
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Permission Rule</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {createError && (
                  <Alert variant="destructive">
                    <AlertDescription>{createError}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label>Path Pattern</Label>
                  <Input
                    placeholder="**/*.ts"
                    value={pathPattern}
                    onChange={(e) => setPathPattern(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Glob pattern for file paths (e.g., src/**/*.ts, *.config.js)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Action</Label>
                  <Select value={action} onValueChange={(v) => { if (v) setAction(v); }}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">Read</SelectItem>
                      <SelectItem value="write">Write</SelectItem>
                      <SelectItem value="delete">Delete</SelectItem>
                      <SelectItem value="execute">Execute</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Effect</Label>
                  <Select value={effect} onValueChange={(v) => { if (v) setEffect(v); }}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">Allow</SelectItem>
                      <SelectItem value="deny">Deny</SelectItem>
                      <SelectItem value="require_review">
                        Require Review
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Maximum Risk Level</Label>
                  <Select value={maxRisk} onValueChange={(v) => { if (v) setMaxRisk(v); }}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
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
                    Create Rule
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {rules.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Shield className="h-12 w-12 text-muted-foreground mb-4 opacity-40" />
            <h3 className="text-lg font-medium mb-1">No permission rules</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Add rules to control agent access to this repository
            </p>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-card border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Path Pattern</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Effect</TableHead>
                <TableHead>Max Risk</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-mono text-sm">
                    {rule.path_pattern || "*"}
                  </TableCell>
                  <TableCell>
                    <span className="capitalize text-sm">
                      {rule.action || "-"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        rule.effect === "allow"
                          ? "bg-green-500/15 text-green-400 border-green-500/30"
                          : rule.effect === "deny"
                          ? "bg-red-500/15 text-red-400 border-red-500/30"
                          : "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                      }
                    >
                      {rule.effect || "-"}
                    </Badge>
                  </TableCell>
                  <TableCell className="capitalize text-sm text-muted-foreground">
                    {rule.max_risk_level || "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(rule.id)}
                      disabled={deleting === rule.id}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    >
                      {deleting === rule.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
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
