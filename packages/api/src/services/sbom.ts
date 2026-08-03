import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { releases, sbomExports } from "../models/schema.js";
import type { GitService } from "./git.js";
import { collectManifestDeps, MAX_MANIFEST_FILES, type Dependency } from "./dep-scan.js";
import { log } from "./logger.js";

export interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo: string;
  downloadLocation: string;
  filesAnalyzed: false;
  licenseDeclared: string;
  licenseConcluded: string;
  supplier?: string;
  externalRefs?: Array<{ referenceCategory: string; referenceType: string; referenceLocator: string }>;
}

export interface SpdxDocument {
  spdxVersion: "SPDX-2.3";
  dataLicense: "CC0-1.0";
  SPDXID: "SPDXRef-DOCUMENT";
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[]; comment?: string };
  packages: SpdxPackage[];
  relationships: Array<{ spdxElementId: string; relatedSpdxElement: string; relationshipType: string }>;
}

export async function generateSbom(db: DB, git: GitService, input: { namespace: string; repo: string; repoId: string; commit: string; releaseId: string; releaseTag: string }): Promise<SpdxDocument> {
  // An SBOM is consumed as an authoritative inventory, so a silent cap is worse
  // than none (#118): scan every manifest (shared bound), and when the bound IS
  // hit, say so in the document itself rather than shipping it as complete.
  const { deps, truncated } = await collectManifestDeps(git, input);
  if (truncated) log("warn", "sbom_truncated", { repoId: input.repoId, releaseId: input.releaseId, cap: MAX_MANIFEST_FILES });

  const rootPkg: SpdxPackage = {
    SPDXID: "SPDXRef-ROOT",
    name: input.repo,
    versionInfo: input.releaseTag,
    downloadLocation: `git+https://useclawhub.com/${input.namespace}/${input.repo}.git#${input.commit}`,
    filesAnalyzed: false,
    licenseDeclared: "NOASSERTION",
    licenseConcluded: "NOASSERTION",
  };

  const pkgs: SpdxPackage[] = [rootPkg];
  const seen = new Set<string>();
  for (const d of deps) {
    const id = `SPDXRef-${d.ecosystem}-${d.name.replace(/[^a-zA-Z0-9]/g, "-")}-${d.version.replace(/[^a-zA-Z0-9]/g, "-")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    pkgs.push({
      SPDXID: id,
      name: d.name,
      versionInfo: d.version,
      downloadLocation: downloadFor(d),
      filesAnalyzed: false,
      licenseDeclared: "NOASSERTION",
      licenseConcluded: "NOASSERTION",
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purlFor(d),
      }],
    });
  }

  const doc: SpdxDocument = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${input.namespace}-${input.repo}-${input.releaseTag}`,
    documentNamespace: `https://useclawhub.com/${input.namespace}/${input.repo}/releases/${encodeURIComponent(input.releaseTag)}/sbom`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: ClawHub"],
      ...(truncated ? { comment: `INCOMPLETE: manifest scan capped at ${MAX_MANIFEST_FILES} files; dependencies from the remaining manifests are not listed.` } : {}),
    },
    packages: pkgs,
    relationships: pkgs.slice(1).map(p => ({ spdxElementId: "SPDXRef-ROOT", relatedSpdxElement: p.SPDXID, relationshipType: "DEPENDS_ON" })),
  };

  await db.insert(sbomExports).values({
    releaseId: input.releaseId,
    format: "spdx-json",
    document: doc as unknown as Record<string, unknown>,
  });

  return doc;
}

function downloadFor(d: Dependency): string {
  switch (d.ecosystem) {
    case "npm": return `https://registry.npmjs.org/${d.name}/-/${d.name}-${d.version}.tgz`;
    case "pypi": return `https://pypi.org/project/${d.name}/${d.version}/`;
    case "crates": return `https://crates.io/crates/${d.name}/${d.version}`;
    case "go": return `https://proxy.golang.org/${d.name}/@v/${d.version}.zip`;
    case "maven": return `NOASSERTION`;
  }
  return "NOASSERTION";
}

function purlFor(d: Dependency): string {
  const eco = d.ecosystem === "crates" ? "cargo" : d.ecosystem === "pypi" ? "pypi" : d.ecosystem === "npm" ? "npm" : d.ecosystem === "go" ? "golang" : "generic";
  return `pkg:${eco}/${d.name}@${d.version}`;
}

export async function getLatestSbom(db: DB, releaseId: string) {
  const r = (await db.select().from(sbomExports).where(eq(sbomExports.releaseId, releaseId)).limit(1))[0];
  return r ? { format: r.format, document: r.document } : null;
}

export async function autoGenerateForRelease(db: DB, git: GitService, input: { releaseId: string; namespace: string; repo: string; repoId: string; commit: string; releaseTag: string }) {
  return generateSbom(db, git, input);
}
