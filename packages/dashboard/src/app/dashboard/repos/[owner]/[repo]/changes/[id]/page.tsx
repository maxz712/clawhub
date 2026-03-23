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
  Columns,
  Rows3,
  MessageSquare,
  Focus,
  List,
  Tag,
  ExternalLink,
  GitCommit,
} from "lucide-react";

interface ReviewFocusArea {
  path: string;
  lines: string;
  description: string;
}

interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

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
  scope?: string[];
  refs?: string[];
  commit_count?: number;
  review_focus?: ReviewFocusArea[];
  review_comments?: ReviewComment[];
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

interface ReviewData {
  id: string;
  verdict: string;
  summary: string;
  reviewer?: string;
  reviewer_name?: string;
  created_at?: string;
  comments?: Array<{
    path: string;
    line?: number;
    body: string;
  }>;
}

function parseDiffSideBySide(diff: string) {
  const lines = diff.split("\n");
  const result: Array<{
    leftNum: number | null;
    leftContent: string;
    leftType: string;
    rightNum: number | null;
    rightContent: string;
    rightType: string;
  }> = [];

  let leftLine = 0;
  let rightLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        leftLine = parseInt(match[1], 10) - 1;
        rightLine = parseInt(match[2], 10) - 1;
      }
      result.push({
        leftNum: null, leftContent: line, leftType: "hunk",
        rightNum: null, rightContent: "", rightType: "hunk",
      });
    } else if (line.startsWith("-")) {
      leftLine++;
      result.push({
        leftNum: leftLine, leftContent: line.slice(1), leftType: "removed",
        rightNum: null, rightContent: "", rightType: "empty",
      });
    } else if (line.startsWith("+")) {
      rightLine++;
      result.push({
        leftNum: null, leftContent: "", leftType: "empty",
        rightNum: rightLine, rightContent: line.slice(1), rightType: "added",
      });
    } else {
      leftLine++;
      rightLine++;
      result.push({
        leftNum: leftLine, leftContent: line.startsWith(" ") ? line.slice(1) : line, leftType: "context",
        rightNum: rightLine, rightContent: line.startsWith(" ") ? line.slice(1) : line, rightType: "context",
      });
    }
  }
  return result;
}

export default function ChangeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ownerParam = params.owner as string;
  const repoParam = params.repo as string;
  const changeId = params.id as string;

  const [repoId, setRepoId] = useState<string>("");
  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "side-by-side">("unified");
  const [reviewMode, setReviewMode] = useState<"focused" | "full">("full");

  const [reviews, setReviews] = useState<ReviewData[]>([]);
  const [reviewVerdict, setReviewVerdict] = useState("comment");
  const [reviewSummary, setReviewSummary] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState("");

  useEffect(() => {
    if (!ownerParam || !repoParam || !changeId) return;

    // Find repo ID from repos list
    api
      .getRepos()
      .then((data) => {
        const items = Array.isArray(data) ? data : data.repos || data.repositories || [];
        const match = items.find(
          (r: { name: string; owner?: string }) =>
            r.name === repoParam &&
            (r.owner === ownerParam || (!r.owner && ownerParam === "_"))
        );
        return match?.id || repoParam;
      })
      .then((id) => {
        setRepoId(id);
        return Promise.all([
          api.getChange(id, changeId),
          api.getReviews(id, changeId).catch(() => []),
        ]);
      })
      .then(([data, reviewsData]) => {
        const c = data.change || data;
        setChange(c);
        if (c.review_focus && c.review_focus.length > 0) {
          setReviewMode("focused");
        }
        const items = Array.isArray(reviewsData)
          ? reviewsData
          : reviewsData.reviews || [];
        setReviews(items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [ownerParam, repoParam, changeId]);

  const performAction = async (
    action: "approve" | "reject" | "merge" | "rollback",
    reason?: string
  ) => {
    if (!repoId) return;
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

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewSummary.trim() || !repoId) return;

    setSubmittingReview(true);
    setReviewError("");
    try {
      await api.submitReview(repoId, changeId, {
        verdict: reviewVerdict,
        summary: reviewSummary,
      });
      const [data, reviewsData] = await Promise.all([
        api.getChange(repoId, changeId),
        api.getReviews(repoId, changeId).catch(() => []),
      ]);
      setChange(data.change || data);
      const items = Array.isArray(reviewsData)
        ? reviewsData
        : reviewsData.reviews || [];
      setReviews(items);
      setReviewSummary("");
      setReviewVerdict("comment");
    } catch (err) {
      setReviewError(
        err instanceof Error ? err.message : "Failed to submit review"
      );
    } finally {
      setSubmittingReview(false);
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
        <Button variant="outline" className="mt-4" onClick={() => router.back()}>
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

  const renderUnifiedDiff = (diff: string) => {
    const lines = diff.split("\n");
    let lineNumOld = 0;
    let lineNumNew = 0;

    return (
      <pre className="text-xs font-mono bg-muted/30 rounded-md p-3 overflow-x-auto max-h-[400px] overflow-y-auto">
        {lines.map((line, j) => {
          let oldNum: number | string = "";
          let newNum: number | string = "";

          if (line.startsWith("@@")) {
            const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
              lineNumOld = parseInt(match[1], 10) - 1;
              lineNumNew = parseInt(match[2], 10) - 1;
            }
          } else if (line.startsWith("-")) {
            lineNumOld++;
            oldNum = lineNumOld;
          } else if (line.startsWith("+")) {
            lineNumNew++;
            newNum = lineNumNew;
          } else {
            lineNumOld++;
            lineNumNew++;
            oldNum = lineNumOld;
            newNum = lineNumNew;
          }

          const colorClass = line.startsWith("+")
            ? "text-green-400 bg-green-500/10"
            : line.startsWith("-")
            ? "text-red-400 bg-red-500/10"
            : line.startsWith("@@")
            ? "text-blue-400 bg-blue-500/10"
            : "";

          return (
            <div key={j} className={`flex ${colorClass}`}>
              <span className="w-10 text-right pr-2 text-muted-foreground/50 select-none shrink-0">
                {oldNum}
              </span>
              <span className="w-10 text-right pr-2 text-muted-foreground/50 select-none shrink-0 border-r border-border mr-2">
                {newNum}
              </span>
              <span className="flex-1">{line}</span>
            </div>
          );
        })}
      </pre>
    );
  };

  const renderSideBySideDiff = (diff: string) => {
    const rows = parseDiffSideBySide(diff);

    return (
      <div className="text-xs font-mono bg-muted/30 rounded-md overflow-x-auto max-h-[400px] overflow-y-auto">
        <div className="grid grid-cols-2 divide-x divide-border">
          <div>
            {rows.map((row, j) => {
              const bgClass =
                row.leftType === "removed" ? "bg-red-500/10 text-red-400"
                : row.leftType === "hunk" ? "bg-blue-500/10 text-blue-400"
                : row.leftType === "empty" ? "bg-muted/20"
                : "";
              return (
                <div key={j} className={`flex px-2 py-0.5 min-h-[1.25rem] ${bgClass}`}>
                  <span className="w-8 text-right pr-2 text-muted-foreground/50 select-none shrink-0">
                    {row.leftNum ?? ""}
                  </span>
                  <span className="flex-1 whitespace-pre">{row.leftContent}</span>
                </div>
              );
            })}
          </div>
          <div>
            {rows.map((row, j) => {
              const bgClass =
                row.rightType === "added" ? "bg-green-500/10 text-green-400"
                : row.rightType === "hunk" ? "bg-blue-500/10 text-blue-400"
                : row.rightType === "empty" ? "bg-muted/20"
                : "";
              return (
                <div key={j} className={`flex px-2 py-0.5 min-h-[1.25rem] ${bgClass}`}>
                  <span className="w-8 text-right pr-2 text-muted-foreground/50 select-none shrink-0">
                    {row.rightNum ?? ""}
                  </span>
                  <span className="flex-1 whitespace-pre">{row.rightContent}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const verdictBadgeClass = (verdict: string) => {
    switch (verdict) {
      case "approve":
        return "bg-green-500/15 text-green-400 border-green-500/30";
      case "request_changes":
        return "bg-red-500/15 text-red-400 border-red-500/30";
      default:
        return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/repos" className="hover:text-foreground">
          Repositories
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/repos/${ownerParam}/${repoParam}`}
          className="hover:text-foreground"
        >
          {ownerParam !== "_" ? `${ownerParam}/` : ""}{repoParam}
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

              <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
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
                      <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
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
            {change.description && <p className="text-sm">{change.description}</p>}
            {change.intent?.description && <p className="text-sm">{change.intent.description}</p>}
            {change.intent?.type && (
              <div className="text-sm">
                <span className="text-muted-foreground">Type:</span>{" "}
                <span className="capitalize">{change.intent.type}</span>
              </div>
            )}
            {change.intent?.files_affected && change.intent.files_affected.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Files affected:</p>
                <div className="space-y-1">
                  {change.intent.files_affected.map((f) => (
                    <div key={f} className="text-sm font-mono bg-muted/30 px-2 py-1 rounded">
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
            {change.commit_count != null && (
              <div className="flex items-center gap-2">
                <GitCommit className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Commits:</span>
                <span>{change.commit_count}</span>
              </div>
            )}
            {change.scope && change.scope.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">Scope:</span>
                {change.scope.map((s) => (
                  <Badge key={s} variant="outline" className="text-xs">{s}</Badge>
                ))}
              </div>
            )}
            {change.refs && change.refs.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">Refs:</span>
                {change.refs.map((ref) => (
                  <a
                    key={ref}
                    href={ref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline font-mono"
                  >
                    {ref}
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Review Mode Toggle + File Changes */}
      {change.files_changed && change.files_changed.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-muted/30 rounded-md p-0.5">
              <Button
                variant={reviewMode === "focused" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setReviewMode("focused")}
                disabled={!change.review_focus || change.review_focus.length === 0}
              >
                <Focus className="h-3 w-3 mr-1" />
                Focused
              </Button>
              <Button
                variant={reviewMode === "full" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setReviewMode("full")}
              >
                <List className="h-3 w-3 mr-1" />
                Full Diff
              </Button>
            </div>
            {reviewMode === "focused" && (
              <span className="text-xs text-muted-foreground">
                Showing agent-highlighted sections only
              </span>
            )}
          </div>

          {/* Focused Review Mode */}
          {reviewMode === "focused" && change.review_focus && change.review_focus.length > 0 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Review Focus Areas ({change.review_focus.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {change.review_focus.map((area, i) => (
                  <div key={i} className="border-l-4 border-blue-500 pl-4 py-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-mono text-blue-400">{area.path}</span>
                      <span className="text-xs text-muted-foreground">lines {area.lines}</span>
                    </div>
                    <p className="text-sm text-foreground">{area.description}</p>
                  </div>
                ))}

                {change.review_comments && change.review_comments.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3">
                        Inline Comments ({change.review_comments.length})
                      </h4>
                      {change.review_comments.map((comment, i) => (
                        <div
                          key={i}
                          className="bg-blue-500/10 border border-blue-500/20 rounded-md px-4 py-3 mb-2"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono text-blue-400">
                              {comment.path}:{comment.line}
                            </span>
                          </div>
                          <p className="text-sm">{comment.body}</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Full Diff View */}
          {reviewMode === "full" && (
            <Card className="bg-card border-border">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    File Changes ({change.files_changed.length})
                  </CardTitle>
                  <div className="flex items-center gap-1 bg-muted/30 rounded-md p-0.5">
                    <Button
                      variant={diffView === "unified" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setDiffView("unified")}
                    >
                      <Rows3 className="h-3 w-3 mr-1" />
                      Unified
                    </Button>
                    <Button
                      variant={diffView === "side-by-side" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setDiffView("side-by-side")}
                    >
                      <Columns className="h-3 w-3 mr-1" />
                      Side by side
                    </Button>
                  </div>
                </div>
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
                          <span className="text-green-400">+{file.additions}</span>
                        )}
                        {file.deletions !== undefined && (
                          <span className="text-red-400">-{file.deletions}</span>
                        )}
                      </div>
                    </div>
                    {file.diff && (
                      diffView === "unified"
                        ? renderUnifiedDiff(file.diff)
                        : renderSideBySideDiff(file.diff)
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Legacy review */}
      {change.review && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Review</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {change.review.reviewer && (
              <p><span className="text-muted-foreground">Reviewer:</span> {change.review.reviewer}</p>
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

      {/* Reviews Section */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Reviews ({reviews.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {reviews.length > 0 && (
            <div className="space-y-3">
              {reviews.map((review, i) => (
                <div
                  key={review.id || i}
                  className="border border-border rounded-md p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={verdictBadgeClass(review.verdict)}>
                        {review.verdict === "request_changes"
                          ? "Changes requested"
                          : review.verdict === "approve"
                          ? "Approved"
                          : "Comment"}
                      </Badge>
                      {(review.reviewer_name || review.reviewer) && (
                        <span className="text-xs text-muted-foreground">
                          by {review.reviewer_name || review.reviewer}
                        </span>
                      )}
                    </div>
                    {review.created_at && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(review.created_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <p className="text-sm">{review.summary}</p>
                  {review.comments && review.comments.length > 0 && (
                    <div className="space-y-2 mt-2">
                      {review.comments.map((comment, j) => (
                        <div key={j} className="bg-muted/30 rounded px-3 py-2 text-xs">
                          <div className="font-mono text-muted-foreground mb-1">
                            {comment.path}{comment.line != null && `:${comment.line}`}
                          </div>
                          <p className="text-sm">{comment.body}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <Separator />

          <form onSubmit={handleSubmitReview} className="space-y-3">
            <h4 className="text-sm font-medium">Submit a Review</h4>

            {reviewError && (
              <Alert variant="destructive">
                <AlertDescription>{reviewError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label className="text-xs">Verdict</Label>
              <Select value={reviewVerdict} onValueChange={(v) => { if (v) setReviewVerdict(v); }}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approve">Approve</SelectItem>
                  <SelectItem value="request_changes">Request Changes</SelectItem>
                  <SelectItem value="comment">Comment</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Summary</Label>
              <Textarea
                placeholder="Write your review summary..."
                value={reviewSummary}
                onChange={(e) => setReviewSummary(e.target.value)}
                rows={3}
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={submittingReview || !reviewSummary.trim()}
                size="sm"
              >
                {submittingReview && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Submit Review
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
