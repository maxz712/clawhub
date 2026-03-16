"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Settings2,
  Loader2,
  ArrowLeft,
  AlertCircle,
  Plus,
  Trash2,
  AlertTriangle,
  Save,
} from "lucide-react";

interface PathOverride {
  pattern: string;
  require_human_approval: boolean;
  min_approvals: number;
}

interface AutoMergeRules {
  risk_levels: string[];
  max_files: number;
}

interface MergePolicy {
  require_human_approval: boolean;
  min_approvals: number;
  agent_approval_weight: number;
  auto_merge_rules: AutoMergeRules;
  path_overrides: PathOverride[];
}

const defaultPolicy: MergePolicy = {
  require_human_approval: true,
  min_approvals: 1,
  agent_approval_weight: 0.5,
  auto_merge_rules: {
    risk_levels: ["low"],
    max_files: 10,
  },
  path_overrides: [],
};

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export default function MergePolicyPage() {
  const params = useParams();
  const repoId = params.id as string;

  const [policy, setPolicy] = useState<MergePolicy>(defaultPolicy);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  // New path override form
  const [newPattern, setNewPattern] = useState("");
  const [newRequireHuman, setNewRequireHuman] = useState(true);
  const [newMinApprovals, setNewMinApprovals] = useState(1);

  useEffect(() => {
    if (!repoId) return;

    api
      .getMergePolicy(repoId)
      .then((data) => {
        const p = data.policy || data;
        setPolicy({
          require_human_approval: p.require_human_approval ?? true,
          min_approvals: p.min_approvals ?? 1,
          agent_approval_weight: p.agent_approval_weight ?? 0.5,
          auto_merge_rules: {
            risk_levels: p.auto_merge_rules?.risk_levels ?? ["low"],
            max_files: p.auto_merge_rules?.max_files ?? 10,
          },
          path_overrides: p.path_overrides ?? [],
        });
      })
      .catch((err) => {
        // 404 means no policy set yet, use defaults
        if (!err.message?.includes("404")) {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
  }, [repoId]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    setSaveSuccess(false);

    try {
      await api.updateMergePolicy(repoId, policy);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save merge policy"
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleRiskLevel = (level: string) => {
    setPolicy((prev) => {
      const levels = prev.auto_merge_rules.risk_levels;
      const updated = levels.includes(level)
        ? levels.filter((l) => l !== level)
        : [...levels, level];
      return {
        ...prev,
        auto_merge_rules: {
          ...prev.auto_merge_rules,
          risk_levels: updated,
        },
      };
    });
  };

  const addPathOverride = () => {
    if (!newPattern.trim()) return;
    setPolicy((prev) => ({
      ...prev,
      path_overrides: [
        ...prev.path_overrides,
        {
          pattern: newPattern.trim(),
          require_human_approval: newRequireHuman,
          min_approvals: newMinApprovals,
        },
      ],
    }));
    setNewPattern("");
    setNewRequireHuman(true);
    setNewMinApprovals(1);
  };

  const removePathOverride = (index: number) => {
    setPolicy((prev) => ({
      ...prev,
      path_overrides: prev.path_overrides.filter((_, i) => i !== index),
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  const showAgentOnlyWarning =
    !policy.require_human_approval;

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
        <span className="text-foreground">Merge Policy</span>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings2 className="h-6 w-6 text-muted-foreground" />
            Merge Policy
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure how changes are approved and merged in this repository
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link href={`/dashboard/repos/${repoId}`}>
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Policy
          </Button>
        </div>
      </div>

      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {saveSuccess && (
        <Alert>
          <AlertDescription className="text-green-400">
            Merge policy saved successfully.
          </AlertDescription>
        </Alert>
      )}

      {/* Agent-only Warning */}
      {showAgentOnlyWarning && (
        <Alert className="border-amber-500/30 bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <AlertDescription className="text-amber-300">
            Human approval is disabled. Agents can approve and merge changes
            without human oversight. This reduces safety guarantees.
          </AlertDescription>
        </Alert>
      )}

      {/* Approval Settings */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Approval Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Require Human Approval */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">
                Require Human Approval
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                When enabled, at least one human must approve before merging
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={policy.require_human_approval}
              onClick={() =>
                setPolicy((prev) => ({
                  ...prev,
                  require_human_approval: !prev.require_human_approval,
                }))
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                policy.require_human_approval
                  ? "bg-primary"
                  : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  policy.require_human_approval
                    ? "translate-x-6"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <Separator />

          {/* Min Approvals */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Minimum Approvals</Label>
            <p className="text-xs text-muted-foreground">
              Number of approvals required before a change can be merged
            </p>
            <Input
              type="number"
              min={0}
              max={10}
              value={policy.min_approvals}
              onChange={(e) =>
                setPolicy((prev) => ({
                  ...prev,
                  min_approvals: parseInt(e.target.value, 10) || 0,
                }))
              }
              className="w-24"
            />
          </div>

          <Separator />

          {/* Agent Approval Weight */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Agent Approval Weight
            </Label>
            <p className="text-xs text-muted-foreground">
              How much an agent approval counts toward the minimum (0 = none, 1
              = full approval)
            </p>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={policy.agent_approval_weight}
              onChange={(e) =>
                setPolicy((prev) => ({
                  ...prev,
                  agent_approval_weight:
                    parseFloat(e.target.value) || 0,
                }))
              }
              className="w-24"
            />
          </div>
        </CardContent>
      </Card>

      {/* Auto-merge Rules */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Auto-merge Rules
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Risk Levels */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Allowed Risk Levels
            </Label>
            <p className="text-xs text-muted-foreground">
              Changes at these risk levels can be auto-merged when conditions
              are met
            </p>
            <div className="flex items-center gap-3 mt-2">
              {RISK_LEVELS.map((level) => {
                const checked =
                  policy.auto_merge_rules.risk_levels.includes(level);
                const colorMap: Record<string, string> = {
                  low: "bg-green-500/15 text-green-400 border-green-500/30",
                  medium:
                    "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
                  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
                  critical: "bg-red-500/15 text-red-400 border-red-500/30",
                };
                return (
                  <label
                    key={level}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRiskLevel(level)}
                      className="rounded border-border"
                    />
                    <Badge
                      variant="outline"
                      className={colorMap[level] || ""}
                    >
                      {level}
                    </Badge>
                  </label>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Max Files */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Maximum Files</Label>
            <p className="text-xs text-muted-foreground">
              Auto-merge is only allowed when the change touches at most this
              many files
            </p>
            <Input
              type="number"
              min={1}
              max={1000}
              value={policy.auto_merge_rules.max_files}
              onChange={(e) =>
                setPolicy((prev) => ({
                  ...prev,
                  auto_merge_rules: {
                    ...prev.auto_merge_rules,
                    max_files: parseInt(e.target.value, 10) || 1,
                  },
                }))
              }
              className="w-24"
            />
          </div>
        </CardContent>
      </Card>

      {/* Path Overrides */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Path Overrides
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Override merge policy for specific file patterns. These take
            precedence over the global settings above.
          </p>

          {policy.path_overrides.length > 0 && (
            <div className="space-y-2">
              {policy.path_overrides.map((override, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border border-border rounded-md px-4 py-3"
                >
                  <div className="space-y-1">
                    <span className="text-sm font-mono">
                      {override.pattern}
                    </span>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        Human approval:{" "}
                        <span
                          className={
                            override.require_human_approval
                              ? "text-green-400"
                              : "text-amber-400"
                          }
                        >
                          {override.require_human_approval
                            ? "required"
                            : "not required"}
                        </span>
                      </span>
                      <span>
                        Min approvals:{" "}
                        <span className="text-foreground">
                          {override.min_approvals}
                        </span>
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removePathOverride(i)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Separator />

          {/* Add Path Override */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Add Override</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Path Pattern</Label>
                <Input
                  placeholder="e.g., src/config/**"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min Approvals</Label>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={newMinApprovals}
                  onChange={(e) =>
                    setNewMinApprovals(parseInt(e.target.value, 10) || 0)
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Human Required</Label>
                <div className="flex items-center gap-2 h-9">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={newRequireHuman}
                    onClick={() => setNewRequireHuman(!newRequireHuman)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      newRequireHuman
                        ? "bg-primary"
                        : "bg-muted-foreground/30"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        newRequireHuman
                          ? "translate-x-6"
                          : "translate-x-1"
                      }`}
                    />
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {newRequireHuman ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={addPathOverride}
              disabled={!newPattern.trim()}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Override
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
