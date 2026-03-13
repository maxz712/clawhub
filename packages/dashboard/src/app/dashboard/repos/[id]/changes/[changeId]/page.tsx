"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StatusBadge } from "@/components/status-badge";
import { RiskBadge } from "@/components/risk-badge";
import {
  Loader2,
  Check,
  X,
  GitMerge,
  Undo2,
  Bot,
  Clock,
  FileText,
  AlertCircle,
} from "lucide-react";

interface ChangeDetail {
  id: string;
  title?: string;
  description?: string;
  status: string;
  risk_level?: string;
  agent_name?: string;
  agent_id?: string;
  created_at?: string;
  updated_at?: string;
  intent?: {
    description?: string;
    type?: string;
    files_affected?: string[];
  };
  files_changed?: Array<{
    path: string;
    action?: string;
    diff?: string;
    additions?: number;
    deletions?: number;
  }>;
  review?: {
    reviewer?: string;
    comment?: string;
    reviewed_at?: string;
  };
}

export default function ChangeReviewPage() {
  const params = useParams();
  const router = useRouter();
  const repoId = params.id as string;
  const changeId = params.changeId as string;

  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);

  useEffect(() => {
    if (!repoId || !changeId) return;

    api
      .getChange(repoId, changeId)
      .then((data) => {
        const c = data.change || data;
        setChange(c);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repoId, changeId]);

  const performAction = async (
    action: "approve" | "reject" | "merge" | "rollback",
    reason?: string
  ) => {
    setActionLoading(action);
    setActionError("");
    try {
      switch (action) {
        case "approve":
          await api.approveChange(repoId, changeId);
          break;
        case "reject":
          await api.rejectChange(repoId, changeId, reason);
          break;
        case "merge":
          await api.mergeChange(repoId, changeId);
          break;
        case "rollback":
          await api.rollbackChange(repoId, changeId);
          break;
      }
      // Reload the change data
      const data = await api.getChange(repoId, changeId);
      setChange(data.change || data);
      setRejectDialogOpen(false);
      setRejectReason("");
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `Failed to ${action} change`
      );
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

  if (error || !change) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-destructive">{error || "Change not found"}</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.back()}
        >
          Go Back
        </Button>
      </div>
    );
  }

  const title =
    change.title || change.intent?.description || `Change ${change.id.slice(0, 8)}`;
  const isPending = change.status === "pending";
  const isApproved = change.status === "approved";
  const isMerged = change.status === "merged";

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
        <span className="text-foreground">Change Review</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{title}</h1>
          <div className="flex items-center gap-3 mt-2">
            <StatusBadge status={change.status} />
            {change.risk_level && <RiskBadge level={change.risk_level} />}
          </div>
        </div>
      </div>

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {/* Action Buttons */}
      <Card className="bg-card border-border">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          {isPending && (
            <>
              <Button
                onClick={() => performAction("approve")}
                disabled={!!actionLoading}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {actionLoading === "approve" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Check className="h-4 w-4 mr-2" />
                )}
                Approve
              </Button>

              <Dialog
                open={rejectDialogOpen}
                onOpenChange={setRejectDialogOpen}
              >
                <DialogTrigger
                  render={<Button variant="destructive" disabled={!!actionLoading} />}
                >
                  <X className="h-4 w-4 mr-2" />
                  Reject
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Reject Change</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Reason (optional)</Label>
                      <Textarea
                        placeholder="Explain why this change is being rejected..."
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        rows={4}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setRejectDialogOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => performAction("reject", rejectReason)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === "reject" ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <X className="h-4 w-4 mr-2" />
                        )}
                        Reject Change
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </>
          )}

          {isApproved && (
            <Button
              onClick={() => performAction("merge")}
              disabled={!!actionLoading}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              {actionLoading === "merge" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <GitMerge className="h-4 w-4 mr-2" />
              )}
              Merge
            </Button>
          )}

          {isMerged && (
            <Button
              variant="outline"
              onClick={() => performAction("rollback")}
              disabled={!!actionLoading}
            >
              {actionLoading === "rollback" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Undo2 className="h-4 w-4 mr-2" />
              )}
              Rollback
            </Button>
          )}

          <span className="text-sm text-muted-foreground ml-auto">
            {change.status === "pending" && "Review this change to proceed"}
            {change.status === "approved" && "Ready to merge"}
            {change.status === "merged" && "Change has been merged"}
            {change.status === "rejected" && "Change was rejected"}
            {change.status === "rolled_back" && "Change was rolled back"}
          </span>
        </CardContent>
      </Card>

      {/* Details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-card border-border md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Intent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {change.description && (
              <p className="text-sm">{change.description}</p>
            )}
            {change.intent?.description && (
              <p className="text-sm">{change.intent.description}</p>
            )}
            {change.intent?.type && (
              <div className="text-sm">
                <span className="text-muted-foreground">Type:</span>{" "}
                <span className="capitalize">{change.intent.type}</span>
              </div>
            )}
            {change.intent?.files_affected &&
              change.intent.files_affected.length > 0 && (
                <div>
                  <p className="text-sm text-muted-foreground mb-2">
                    Files affected:
                  </p>
                  <div className="space-y-1">
                    {change.intent.files_affected.map((f) => (
                      <div
                        key={f}
                        className="text-sm font-mono bg-muted/30 px-2 py-1 rounded"
                      >
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {change.agent_name && (
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Agent:</span>
                <span>{change.agent_name}</span>
              </div>
            )}
            {change.created_at && (
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Created:</span>
                <span>{new Date(change.created_at).toLocaleString()}</span>
              </div>
            )}
            {change.updated_at && (
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Updated:</span>
                <span>{new Date(change.updated_at).toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">ID:</span>
              <span className="font-mono text-xs">{change.id.slice(0, 12)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* File Changes */}
      {change.files_changed && change.files_changed.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              File Changes ({change.files_changed.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {change.files_changed.map((file, i) => (
              <div key={i}>
                {i > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-mono">{file.path}</span>
                  <div className="flex items-center gap-2 text-xs">
                    {file.action && (
                      <span
                        className={`capitalize ${
                          file.action === "added" || file.action === "add"
                            ? "text-green-400"
                            : file.action === "deleted" || file.action === "delete"
                            ? "text-red-400"
                            : "text-yellow-400"
                        }`}
                      >
                        {file.action}
                      </span>
                    )}
                    {file.additions !== undefined && (
                      <span className="text-green-400">
                        +{file.additions}
                      </span>
                    )}
                    {file.deletions !== undefined && (
                      <span className="text-red-400">
                        -{file.deletions}
                      </span>
                    )}
                  </div>
                </div>
                {file.diff && (
                  <pre className="text-xs font-mono bg-muted/30 rounded-md p-3 overflow-x-auto max-h-[300px] overflow-y-auto">
                    {file.diff.split("\n").map((line, j) => (
                      <div
                        key={j}
                        className={
                          line.startsWith("+")
                            ? "text-green-400"
                            : line.startsWith("-")
                            ? "text-red-400"
                            : line.startsWith("@@")
                            ? "text-blue-400"
                            : ""
                        }
                      >
                        {line}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Review info */}
      {change.review && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Review
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {change.review.reviewer && (
              <p>
                <span className="text-muted-foreground">Reviewer:</span>{" "}
                {change.review.reviewer}
              </p>
            )}
            {change.review.comment && <p>{change.review.comment}</p>}
            {change.review.reviewed_at && (
              <p className="text-xs text-muted-foreground">
                {new Date(change.review.reviewed_at).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
