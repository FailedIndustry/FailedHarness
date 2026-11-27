import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { ChevronRightIcon, FileIcon } from "lucide-react";
import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { getDiffLineStat } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { PullRequestDiffStat } from "../pullRequestPresentation";
import type { ExcerptCommenting } from "./GuideExcerpt";
import { GuideFileDiff } from "./GuideFileDiff";

/** Changed files as rows that each open onto their diff. */
export function GuideFileList({
  files,
  diffs,
  loading,
  commenting,
  loadDiffFiles,
}: {
  files: ReadonlyArray<{ readonly path: string; readonly note?: ReactNode }>;
  diffs: ReadonlyMap<string, FileDiffMetadata>;
  loading: boolean;
  commenting: ExcerptCommenting | null;
  loadDiffFiles: FileDiffContentsLoader;
}) {
  const gt = useGT();
  return (
    <DiffWorkerPoolProvider>
      <ul className="flex flex-col overflow-hidden rounded-lg border border-border/60">
        {files.map((file) => {
          const diff = diffs.get(file.path);
          const stat = diff === undefined ? null : getDiffLineStat([diff]);
          return (
            <li key={file.path} className="border-border/60 not-first:border-t">
              <Collapsible>
                <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
                  />
                  <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-foreground">{file.path}</span>
                  {file.note === undefined ? null : (
                    <span className="ml-auto min-w-0 truncate text-muted-foreground @max-[30rem]/guide:hidden">
                      {file.note}
                    </span>
                  )}
                  {stat !== null ? (
                    <PullRequestDiffStat
                      additions={stat.additions}
                      deletions={stat.deletions}
                      className={cn("shrink-0 font-mono", file.note === undefined && "ml-auto")}
                    />
                  ) : null}
                </CollapsibleTrigger>
                <CollapsiblePanel animate={false}>
                  {diff !== undefined ? (
                    <GuideFileDiff
                      path={file.path}
                      file={diff}
                      commenting={commenting}
                      loadDiffFiles={loadDiffFiles}
                    />
                  ) : (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {loading
                        ? gt("Loading the diff...")
                        : gt("This file is not in the loaded diff.")}
                    </p>
                  )}
                </CollapsiblePanel>
              </Collapsible>
            </li>
          );
        })}
      </ul>
    </DiffWorkerPoolProvider>
  );
}
