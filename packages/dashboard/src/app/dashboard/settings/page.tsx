"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Settings,
  Loader2,
  Save,
  AlertTriangle,
  Plus,
  Trash2,
} from "lucide-react";

interface EscalationTrigger {
  condition: string;
  threshold: string;
}

interface MergePolicyDefaults {
  require_human_approval: boolean;
  min_approvals: number;
  agent_approval_weight: number;
  auto_merge_risk_levels: string[];
  auto_merge_max_files: number;
}

interface PathOverride {
  pattern: string;
  require_human_approval: boolean;
  min_approvals: number;
}

interface GovernanceSettings {
  escalation_triggers: EscalationTrigger[];
  merge_policy_defaults: MergePolicyDefaults;
  path_overrides: PathOverride[];
  reviewer_assignment: {
    mode: string;
    default_reviewers: string[];
  };
}

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

const defaultSettings: GovernanceSettings = {
  escalation_triggers: [
    { condition: "risk_level", threshold: "high" },
    { condition: "reviewer_uncertainty", threshold: "true" },
    { condition: "has_conflicts", threshold: "true" },
  ],
  merge_policy_defaults: {
    require_human_approval: true,
    min_approvals: 1,
    agent_approval_weight: 0.5,
    auto_merge_risk_levels: ["low"],
    auto_merge_max_files: 10,
  },
  path_overrides: [],
  reviewer_assignment: {
    mode: "auto",
    default_reviewers: [],
  },
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<GovernanceSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  // New escalation trigger form
  const [newCondition, setNewCondition] = useState("risk_level");
  const [newThreshold, setNewThreshold] = useState("high");

  // New path override form
  const [newPattern, setNewPattern] = useState("");
  const [newOverrideHuman, setNewOverrideHuman] = useState(true);
  const [newOverrideApprovals, setNewOverrideApprovals] = useState(1);

  useEffect(() => {
    api
      .getGovernanceSettings()
      .then((data) => {
        const s = data.settings || data;
        setSettings({
          escalation_triggers: s.escalation_triggers || defaultSettings.escalation_triggers,
          merge_policy_defaults: {
            ...defaultSettings.merge_policy_defaults,
            ...(s.merge_policy_defaults || {}),
          },
          path_overrides: s.path_overrides || [],
          reviewer_assignment: {
            ...defaultSettings.reviewer_assignment,
            ...(s.reviewer_assignment || {}),
          },
        });
      })
      .catch(() => {
        // Use defaults if no settings exist yet
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaveSuccess(false);

    try {
      await api.updateGovernanceSettings(settings as unknown as Record<string, unknown>);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRiskLevel = (level: string) => {
    setSettings((prev) => {
      const levels = prev.merge_policy_defaults.auto_merge_risk_levels;
      const updated = levels.includes(level)
        ? levels.filter((l) => l !== level)
        : [...levels, level];
      return {
        ...prev,
        merge_policy_defaults: {
          ...prev.merge_policy_defaults,
          auto_merge_risk_levels: updated,
        },
      };
    });
  };

  const addEscalationTrigger = () => {
    setSettings((prev) => ({
      ...prev,
      escalation_triggers: [
        ...prev.escalation_triggers,
        { condition: newCondition, threshold: newThreshold },
      ],
    }));
    setNewCondition("risk_level");
    setNewThreshold("high");
  };

  const removeEscalationTrigger = (index: number) => {
    setSettings((prev) => ({
      ...prev,
      escalation_triggers: prev.escalation_triggers.filter((_, i) => i !== index),
    }));
  };

  const addPathOverride = () => {
    if (!newPattern.trim()) return;
    setSettings((prev) => ({
      ...prev,
      path_overrides: [
        ...prev.path_overrides,
        {
          pattern: newPattern.trim(),
          require_human_approval: newOverrideHuman,
          min_approvals: newOverrideApprovals,
        },
      ],
    }));
    setNewPattern("");
    setNewOverrideHuman(true);
    setNewOverrideApprovals(1);
  };

  const removePathOverride = (index: number) => {
    setSettings((prev) => ({
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

  const showAgentOnlyWarning = !settings.merge_policy_defaults.require_human_approval;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="h-6 w-6 text-muted-foreground" />
            Governance Settings
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure how your agents operate. Set boundaries you are comfortable with.
          </p>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save Settings
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {saveSuccess && (
        <Alert>
          <AlertDescription className="text-green-400">
            Settings saved successfully.
          </AlertDescription>
        </Alert>
      )}

      {/* Escalation Triggers */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Escalation Triggers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Conditions that surface changes for human attention. When triggered, the change appears in your Attention Feed.
          </p>

          {settings.escalation_triggers.length > 0 && (
            <div className="space-y-2">
              {settings.escalation_triggers.map((trigger, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border border-border rounded-md px-4 py-3"
                >
                  <div className="text-sm">
                    <span className="font-medium capitalize">{trigger.condition.replace(/_/g, " ")}</span>
                    <span className="text-muted-foreground"> = </span>
                    <span>{trigger.threshold}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeEscalationTrigger(i)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Separator />

          <div className="flex items-end gap-3">
            <div className="space-y-1 flex-1">
              <Label className="text-xs">Condition</Label>
              <Select value={newCondition} onValueChange={(v) => { if (v) setNewCondition(v); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="risk_level">Risk Level</SelectItem>
                  <SelectItem value="reviewer_uncertainty">Reviewer Uncertainty</SelectItem>
                  <SelectItem value="has_conflicts">Has Conflicts</SelectItem>
                  <SelectItem value="file_count">File Count Above</SelectItem>
                  <SelectItem value="path_pattern">Path Pattern</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex-1">
              <Label className="text-xs">Threshold</Label>
              <Input
                value={newThreshold}
                onChange={(e) => setNewThreshold(e.target.value)}
                placeholder="e.g., high, true, 20"
              />
            </div>
            <Button variant="outline" size="sm" onClick={addEscalationTrigger}>
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Merge Policy Defaults */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Merge Policy Defaults
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {showAgentOnlyWarning && (
            <Alert className="border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <AlertDescription className="text-amber-300">
                Human approval is disabled. Agents can approve and merge changes
                without human oversight.
              </AlertDescription>
            </Alert>
          )}

          {/* Require Human Approval */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Require Human Approval</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                At least one human must approve before merging
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.merge_policy_defaults.require_human_approval}
              onClick={() =>
                setSettings((prev) => ({
                  ...prev,
                  merge_policy_defaults: {
                    ...prev.merge_policy_defaults,
                    require_human_approval: !prev.merge_policy_defaults.require_human_approval,
                  },
                }))
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.merge_policy_defaults.require_human_approval
                  ? "bg-primary"
                  : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.merge_policy_defaults.require_human_approval
                    ? "translate-x-6"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium">Minimum Approvals</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={settings.merge_policy_defaults.min_approvals}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  merge_policy_defaults: {
                    ...prev.merge_policy_defaults,
                    min_approvals: parseInt(e.target.value, 10) || 0,
                  },
                }))
              }
              className="w-24"
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium">Agent Approval Weight</Label>
            <p className="text-xs text-muted-foreground">
              How much an agent approval counts (0 = none, 1 = full approval)
            </p>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={settings.merge_policy_defaults.agent_approval_weight}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  merge_policy_defaults: {
                    ...prev.merge_policy_defaults,
                    agent_approval_weight: parseFloat(e.target.value) || 0,
                  },
                }))
              }
              className="w-24"
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium">Auto-merge Risk Levels</Label>
            <div className="flex items-center gap-3 mt-2">
              {RISK_LEVELS.map((level) => {
                const checked =
                  settings.merge_policy_defaults.auto_merge_risk_levels.includes(level);
                const colorMap: Record<string, string> = {
                  low: "bg-green-500/15 text-green-400 border-green-500/30",
                  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
                  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
                  critical: "bg-red-500/15 text-red-400 border-red-500/30",
                };
                return (
                  <label key={level} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRiskLevel(level)}
                      className="rounded border-border"
                    />
                    <Badge variant="outline" className={colorMap[level] || ""}>
                      {level}
                    </Badge>
                  </label>
                );
              })}
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium">Auto-merge Max Files</Label>
            <Input
              type="number"
              min={1}
              max={1000}
              value={settings.merge_policy_defaults.auto_merge_max_files}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  merge_policy_defaults: {
                    ...prev.merge_policy_defaults,
                    auto_merge_max_files: parseInt(e.target.value, 10) || 1,
                  },
                }))
              }
              className="w-24"
            />
          </div>
        </CardContent>
      </Card>

      {/* Reviewer Assignment */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Reviewer Assignment
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Assignment Mode</Label>
            <Select
              value={settings.reviewer_assignment.mode}
              onValueChange={(v) => {
                if (v) setSettings((prev) => ({
                  ...prev,
                  reviewer_assignment: { ...prev.reviewer_assignment, mode: v },
                }));
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="round_robin">Round Robin</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              How reviewer agents are assigned to incoming changes
            </p>
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
            Override merge policy for specific file patterns. These take precedence over defaults.
          </p>

          {settings.path_overrides.length > 0 && (
            <div className="space-y-2">
              {settings.path_overrides.map((override, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border border-border rounded-md px-4 py-3"
                >
                  <div className="space-y-1">
                    <span className="text-sm font-mono">{override.pattern}</span>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        Human approval:{" "}
                        <span className={override.require_human_approval ? "text-green-400" : "text-amber-400"}>
                          {override.require_human_approval ? "required" : "not required"}
                        </span>
                      </span>
                      <span>
                        Min approvals: <span className="text-foreground">{override.min_approvals}</span>
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
                  value={newOverrideApprovals}
                  onChange={(e) => setNewOverrideApprovals(parseInt(e.target.value, 10) || 0)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Human Required</Label>
                <div className="flex items-center gap-2 h-9">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={newOverrideHuman}
                    onClick={() => setNewOverrideHuman(!newOverrideHuman)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      newOverrideHuman ? "bg-primary" : "bg-muted-foreground/30"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        newOverrideHuman ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {newOverrideHuman ? "Yes" : "No"}
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
