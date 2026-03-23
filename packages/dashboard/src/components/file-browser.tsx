"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { File, Folder, ChevronRight, Loader2 } from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "tree" | "blob";
  children?: FileEntry[];
}

interface FileBrowserProps {
  repoId: string;
  branch?: string;
}

export function FileBrowser({ repoId, branch }: FileBrowserProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listFiles(repoId, branch)
      .then((data) => {
        const items = Array.isArray(data) ? data : data.files || data.tree || [];
        setFiles(items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repoId, branch]);

  const handleFileClick = async (path: string) => {
    setSelectedFile(path);
    setContentLoading(true);
    setFileContent("");
    try {
      const data = await api.getFile(repoId, path, branch);
      const content =
        typeof data === "string"
          ? data
          : data.content || data.data || JSON.stringify(data, null, 2);
      setFileContent(content);
    } catch (err) {
      setFileContent(
        `Error loading file: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setContentLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>Failed to load files: {error}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card className="bg-card border-border md:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Files
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[500px] overflow-y-auto">
            {files.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 pb-4">
                No files in this repository
              </p>
            ) : (
              <FileTree
                entries={files}
                selectedFile={selectedFile}
                onFileClick={handleFileClick}
                depth={0}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border md:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground font-mono">
            {selectedFile || "Select a file to view"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {contentLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectedFile ? (
            <pre className="text-sm font-mono bg-muted/30 rounded-md p-4 overflow-x-auto max-h-[500px] overflow-y-auto whitespace-pre-wrap break-words">
              {fileContent}
            </pre>
          ) : (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Click a file in the tree to view its contents
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FileTree({
  entries,
  selectedFile,
  onFileClick,
  depth,
}: {
  entries: FileEntry[];
  selectedFile: string | null;
  onFileClick: (path: string) => void;
  depth: number;
}) {
  return (
    <div>
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.path}
          entry={entry}
          selectedFile={selectedFile}
          onFileClick={onFileClick}
          depth={depth}
        />
      ))}
    </div>
  );
}

function FileTreeItem({
  entry,
  selectedFile,
  onFileClick,
  depth,
}: {
  entry: FileEntry;
  selectedFile: string | null;
  onFileClick: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isDir = entry.type === "directory" || entry.type === "tree";
  const isSelected = selectedFile === entry.path;

  return (
    <div>
      <button
        onClick={() => {
          if (isDir) {
            setExpanded(!expanded);
          } else {
            onFileClick(entry.path);
          }
        }}
        className={`w-full flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-accent/50 transition-colors text-left ${
          isSelected ? "bg-accent text-accent-foreground" : "text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 16 + 16}px` }}
      >
        {isDir ? (
          <>
            <ChevronRight
              className={`h-3 w-3 flex-shrink-0 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            <Folder className="h-4 w-4 flex-shrink-0 text-blue-400" />
          </>
        ) : (
          <>
            <span className="w-3" />
            <File className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {isDir && expanded && entry.children && (
        <FileTree
          entries={entry.children}
          selectedFile={selectedFile}
          onFileClick={onFileClick}
          depth={depth + 1}
        />
      )}
    </div>
  );
}
