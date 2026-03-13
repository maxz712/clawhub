import { ClawForgeClient, ClawForgeError } from "./client.js";
import type { FileChange } from "./client.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

function formatError(err: unknown): ToolResult {
  if (err instanceof ClawForgeError) {
    return {
      content: `Error (${err.status}): ${err.message}`,
      isError: true,
    };
  }
  if (err instanceof Error) {
    return {
      content: `Error: ${err.message}`,
      isError: true,
    };
  }
  return {
    content: `Unknown error: ${String(err)}`,
    isError: true,
  };
}

export interface CreateRepoParams {
  name: string;
  description?: string;
}

export interface PushParams {
  repo_id: string;
  intent: string;
  branch: string;
  files: FileChange[];
  description?: string;
}

export interface StatusParams {
  repo_id: string;
  change_id?: string;
}

export interface BrowseParams {
  repo_id: string;
  path?: string;
}

export type ToolHandlers = ReturnType<typeof createTools>;

export function createTools(client: ClawForgeClient) {
  return {
    clawforge_create_repo: async (
      params: CreateRepoParams,
    ): Promise<ToolResult> => {
      try {
        const repo = await client.createRepo(
          params.name,
          params.description,
        );
        return {
          content: [
            `Repository created successfully.`,
            `  ID: ${repo.id}`,
            `  Name: ${repo.name}`,
            repo.description
              ? `  Description: ${repo.description}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err) {
        return formatError(err);
      }
    },

    clawforge_push: async (params: PushParams): Promise<ToolResult> => {
      try {
        if (!params.files || params.files.length === 0) {
          return {
            content: "Error: No files provided. Include at least one file change.",
            isError: true,
          };
        }

        for (const file of params.files) {
          if (!file.path || !file.action) {
            return {
              content:
                "Error: Each file must have a 'path' and 'action' (create, update, or delete).",
              isError: true,
            };
          }
          if (
            file.action !== "delete" &&
            (file.content === undefined || file.content === null)
          ) {
            return {
              content: `Error: File '${file.path}' with action '${file.action}' must include 'content'.`,
              isError: true,
            };
          }
        }

        const change = await client.submitChange(params.repo_id, {
          intent: params.intent,
          branch: params.branch,
          files: params.files,
          description: params.description,
        });

        return {
          content: [
            `Change submitted successfully.`,
            `  Change ID: ${change.id}`,
            `  Branch: ${change.branch}`,
            `  Status: ${change.status}`,
            `  Intent: ${change.intent}`,
            `  Files: ${params.files.length} file(s)`,
          ].join("\n"),
        };
      } catch (err) {
        return formatError(err);
      }
    },

    clawforge_status: async (
      params: StatusParams,
    ): Promise<ToolResult> => {
      try {
        const result = await client.getChangeStatus(
          params.repo_id,
          params.change_id,
        );

        if (Array.isArray(result)) {
          if (result.length === 0) {
            return { content: "No changes found for this repository." };
          }

          const lines = result.map(
            (c) =>
              `  [${c.status}] ${c.id} - ${c.intent} (branch: ${c.branch})`,
          );
          return {
            content: `Changes for repository:\n${lines.join("\n")}`,
          };
        }

        return {
          content: [
            `Change details:`,
            `  ID: ${result.id}`,
            `  Status: ${result.status}`,
            `  Intent: ${result.intent}`,
            `  Branch: ${result.branch}`,
            result.description
              ? `  Description: ${result.description}`
              : null,
            `  Created: ${result.created_at}`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err) {
        return formatError(err);
      }
    },

    clawforge_list_repos: async (): Promise<ToolResult> => {
      try {
        const repos = await client.listRepos();

        if (repos.length === 0) {
          return {
            content:
              "No repositories found. Use clawforge_create_repo to create one.",
          };
        }

        const lines = repos.map(
          (r) =>
            `  ${r.name} (${r.id})${r.description ? ` - ${r.description}` : ""}`,
        );
        return {
          content: `Your repositories:\n${lines.join("\n")}`,
        };
      } catch (err) {
        return formatError(err);
      }
    },

    clawforge_browse: async (
      params: BrowseParams,
    ): Promise<ToolResult> => {
      try {
        if (params.path) {
          const content = await client.getFileContents(
            params.repo_id,
            params.path,
          );
          return {
            content: `File: ${params.path}\n---\n${content}`,
          };
        }

        const files = await client.listFiles(params.repo_id);

        if (files.length === 0) {
          return {
            content:
              "Repository is empty. Use clawforge_push to add files.",
          };
        }

        return {
          content: `Files in repository:\n${files.map((f) => `  ${f}`).join("\n")}`,
        };
      } catch (err) {
        return formatError(err);
      }
    },
  };
}
