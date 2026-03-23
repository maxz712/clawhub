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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DecisionCard, type DecisionData } from "@/components/decision-card";
import { StatusBadge } from "@/components/status-badge";
import { RiskBadge } from "@/components/risk-badge";
import {
  Loader2,
  Check,
  X,
  GitMerge,
  Bot,
  Clock,
  FileText,
  AlertCircle,
  AlertTriangle,
  MessageSquare,
  CheckCircle,
  Circle,
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
  scope?: string[];
  commit_count?: number;
  review_focus?: Array<{ path: string; lines: string; description: string }>;
  review_comments?: Array<{ path: string; line: number; body: string }>;
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
  uncertainty?: string;
  key_decisions?: DecisionData[];
  review_coverage?: {
    verified?: string[];
    not_examined?: string[];
  };
  escalation_reason?: string;
  escalation_type?: string;
}

export default function DecisionViewPage() {
  const params = useParams();
  const router = useRouter();
  const itemId = params.id as string;

  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [repoId, setRepoId] = useState<string>("");
  const [repoName, setRepoName] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [comment, setComment] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);

  useEffect(() => {
    if (!itemId) return;

    api
      .getAttentionItem(itemId)
      .then((data) => {
        const item = data.item || data;
        setRepoId(item.repo_id || "");
        setRepoName(item.repo_name || "");
        setOwner(item.owner || "");

        // If the attention item includes full change detail, use it
        if (item.change) {
          setChange(item.change);
        } else if (item.repo_id && item.change_id) {
          return api.getChange(item.repo_id, item.change_id).then((cd) => {
            const c = cd.change || cd;
            // Merge escalation info
            c.escalation_reason = item.reason;
            c.escalation_type = item.type;
            c.uncertainty = item.uncertainty || c.uncertainty;
            c.key_decisions = item.key_decisions || c.key_decisions;
            setChange(c);
          });
        } else {
          // Treat the attention item itself as the change
          setChange({
            id: item.id,
            title: item.change_title || item.title,
            description: item.reason,
            status: "pending",
            risk_level: item.risk_level,
            agent_name: item.agent_name,
            created_at: item.created_at,
            escalation_reason: item.reason,
            escalation_type: item.type,
            uncertainty: item.uncertainty,
            key_decisions: item.key_decisions,
          });
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [itemId]);

  const performAction = async (action: "approve" | "reject" | "merge") => {
    if (!repoId || !change) return;
    setActionLoading(action);
    setActionError("");
    try {
      if (action === "approve") {
        await api.approveChange(repoId, change.id);
        await api.mergeChange(repoId, change.id);
      } else if (action === "reject") {
        await api.rejectChange(repoId, change.id);
      } else if (action === "merge") {
        await api.mergeChange(repoId, change.id);
      }
      const data = await api.getChange(repoId, change.id);
      setChange(data.change || data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim() || !repoId || !change) return;
    setSubmittingComment(true);
    try {
      await api.submitReview(repoId, change.id, {
        verdict: "comment",
        summary: comment,
      });
      setComment("");
      const data = await api.getChange(repoId, change.id);
      setChange(data.change || data);
    } catch {
      // Ignore
    } finally {
      setSubmittingComment(false);
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
        <p className="text-destructive">{error || "Item not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.back()}>
          Go Back
        </Button>
      </div>
    );
  }

  const title = change.title || change.intent?.description || `Change ${change.id.slice(0, 8)}`;
  const isPending = change.status === "pending";
  const isApproved = change.status === "approved";
  const narrative = change.description || change.intent?.description || "";
  const decisions = change.key_decisions || [];
  const uncertainty = change.uncertainty || change.escalation_reason || "";
  const coverage = change.review_coverage;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/attention" className="hover:text-foreground">
          Attention
        </Link>
        <span>/</span>
        <span className="text-foreground">{title}</span>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <StatusBadge status={change.status} />
          {change.risk_level && <RiskBadge level={change.risk_level} />}
          {change.agent_name && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" />
              {change.agent_name}
            </span>
          )}
          {change.files_changed && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <FileText className="h-3.5 w-3.5" />
              {change.files_changed.length} file{change.files_changed.length !== 1 ? "s" : ""}
            </span>
          )}
          {change.created_at && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {new Date(change.created_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {/* Escalation reason banner */}
      {change.escalation_type && (
        <div className={`rounded-md px-4 py-3 text-sm flex items-start gap-2 ${
          change.escalation_type === "conflict"
            ? "bg-red-500/10 border border-red-500/20 text-red-300"
            : change.escalation_type === "policy_gate"
            ? "bg-red-500/10 border border-red-500/20 text-red-300"
            : "bg-yellow-500/10 border border-yellow-500/20 text-yellow-300"
        }`}>
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{change.escalation_reason || `Escalated: ${change.escalation_type}`}</span>
        </div>
      )}

      {/* Narrative */}
      {narrative && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Narrative
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed">{narrative}</p>
            {change.intent?.type && (
              <p className="text-xs text-muted-foreground mt-2">
                Type: <span className="capitalize">{change.intent.type}</span>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Key decisions */}
      {decisions.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">Key Decisions</h3>
          {decisions.map((d, i) => (
            <DecisionCard key={i} decision={d} />
          ))}
        </div>
      )}

      {/* Uncertainty */}
      {uncertainty && (
        <Card className="bg-card border-border border-l-4 border-l-yellow-500">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-yellow-400 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Uncertainty
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground italic">{uncertainty}</p>
          </CardContent>
        </Card>
      )}

      {/* Review coverage */}
      {coverage && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Review Coverage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {coverage.verified && coverage.verified.length > 0 && (
              <div className="space-y-1">
                {coverage.verified.map((f) => (
                  <div key={f} className="flex items-center gap-2 text-sm">
                    <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                    <span className="font-mono text-xs">{f}</span>
                  </div>
                ))}
              </div>
            )}
            {coverage.not_examined && coverage.not_examined.length > 0 && (
              <div className="space-y-1">
                {coverage.not_examined.map((f) => (
                  <div key={f} className="flex items-center gap-2 text-sm">
                    <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono text-xs text-muted-foreground">{f}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Actions */}
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
                Approve & Merge
              </Button>

              <Button
                variant="destructive"
                onClick={() => performAction("reject")}
                disabled={!!actionLoading}
              >
                {actionLoading === "reject" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <X className="h-4 w-4 mr-2" />
                )}
                Reject
              </Button>
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

          {owner && repoName && (
            <Link
              href={`/dashboard/repos/${owner}/${repoName}/changes/${change.id}`}
              className="text-sm text-muted-foreground hover:text-foreground ml-auto"
            >
              View Full Diff
            </Link>
          )}
        </CardContent>
      </Card>

      {/* Comment */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Comment
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleComment} className="space-y-3">
            <Textarea
              placeholder="Leave a comment for the agent or other reviewers..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={submittingComment || !comment.trim()}
              >
                {submittingComment && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Comment
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
