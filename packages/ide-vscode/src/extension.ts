import * as vscode from "vscode";

interface Change { id: string; branch: string; intent: string; status: string; risk: string; repoId: string }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cfg = vscode.workspace.getConfiguration("clawhub");
  const base = (cfg.get<string>("apiUrl") ?? "http://localhost:3000").replace(/\/+$/, "");
  const token = cfg.get<string>("token") ?? "";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`clawhub_${res.status}: ${text}`);
  return data as T;
}

class ChangeTreeProvider implements vscode.TreeDataProvider<Change> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh() { this._onDidChangeTreeData.fire(); }

  async getChildren(): Promise<Change[]> {
    try {
      const repos = await api<{ repos: Array<{ id: string; name: string; namespaceType: "agent" | "org"; namespaceId: string }> }>("GET", "/api/v1/repos");
      if (!repos.repos.length) return [];
      const all: Change[] = [];
      for (const r of repos.repos.slice(0, 5)) {
        try {
          const ns = r.namespaceId;
          const c = await api<{ changes: Change[] }>("GET", `/api/v1/repos/${ns}/${r.name}/changes`);
          all.push(...c.changes.slice(0, 10));
        } catch { /* skip */ }
      }
      return all;
    } catch (e) {
      vscode.window.showErrorMessage(`ClawHub: ${(e as Error).message}`);
      return [];
    }
  }

  getTreeItem(ch: Change): vscode.TreeItem {
    const item = new vscode.TreeItem(`${ch.intent} [${ch.risk}]`, vscode.TreeItemCollapsibleState.None);
    item.description = `${ch.branch} · ${ch.status}`;
    item.command = { command: "clawhub.openChange", title: "Open", arguments: [ch] };
    return item;
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new ChangeTreeProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider("clawhub.changes", provider));

  ctx.subscriptions.push(vscode.commands.registerCommand("clawhub.listChanges", () => provider.refresh()));

  ctx.subscriptions.push(vscode.commands.registerCommand("clawhub.openChange", async (ch: Change | undefined) => {
    if (!ch) return;
    const doc = await vscode.workspace.openTextDocument({ content: `Change ${ch.id}\n\n${ch.intent}\nRisk: ${ch.risk}\nBranch: ${ch.branch}\nStatus: ${ch.status}\n`, language: "markdown" });
    await vscode.window.showTextDocument(doc);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("clawhub.approve", async () => {
    const id = await vscode.window.showInputBox({ prompt: "Change URL or id" });
    if (!id) return;
    vscode.window.showInformationMessage(`Approval requested (${id}). Wire to your repo context.`);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("clawhub.requestChanges", async () => {
    vscode.window.showInformationMessage("Request changes — use the ClawHub dashboard for now.");
  }));
}

export function deactivate() { /* noop */ }
