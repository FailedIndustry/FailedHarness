import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";

import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { GuideFileList } from "../guide/GuideFileList";
import { useGuideDiffFiles } from "../guide/useGuideDiffFiles";
import { pathspecFilter, shortSha } from "./reviewPacket.logic";

/**
 * The pull request's own diff, narrowed to a claim's pathspecs. It is the diff at the pull
 * request's head, which is the packet's range only while the packet is not behind.
 */
export function PacketClaimCode({
  environmentId,
  reference,
  pullRequestHeadSha,
  packetHeadSha,
  behind,
  paths,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestHeadSha: string | undefined;
  packetHeadSha: string;
  behind: boolean;
  paths: ReadonlyArray<string>;
}) {
  const gt = useGT();
  const headSha = pullRequestHeadSha ?? packetHeadSha;
  const filter = pathspecFilter(paths);
  const diff = useGuideDiffFiles({ environmentId, reference, headSha, wantedPaths: null });
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);
  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit: null,
    cacheKey: `pull-request-packet:${environmentId}:${reference.repository}:${reference.number}:${headSha}`,
  });
  const matched = [...diff.files.keys()].filter(filter.matches).toSorted();

  return (
    <div className="flex min-w-0 flex-col gap-2 pt-1">
      {behind ? (
        <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            <T>
              Showing the code at the latest push, <Var>{shortSha(headSha)}</Var>. The packet was
              recorded earlier, at <Var>{shortSha(packetHeadSha)}</Var>.
            </T>
          </span>
        </p>
      ) : null}
      {matched.length > 0 ? (
        <GuideFileList
          files={matched.map((path) => ({ path }))}
          diffs={diff.files}
          loading={diff.loading}
          commenting={null}
          loadDiffFiles={loadDiffFiles}
        />
      ) : null}
      {diff.error !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            <T>
              The diff could not be loaded: <Var>{diff.error}</Var>
            </T>
          </span>
          <Button size="xs" variant="outline" onClick={diff.retry}>
            {gt("Retry")}
          </Button>
        </p>
      ) : diff.loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          {gt("Loading the diff...")}
        </p>
      ) : matched.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No changed file in this pull request matches these paths.</T>
        </p>
      ) : null}
      {filter.unsupported.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>
            Not applied here: <Var>{<code>{filter.unsupported.join(" ")}</code>}</Var>
          </T>
        </p>
      ) : null}
    </div>
  );
}
