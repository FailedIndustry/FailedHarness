import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

interface QueueNeighbour {
  readonly number: number;
  readonly title: string;
}

/** Steps through the pull request list in the order it is shown, without going back to it. */
export function PullRequestQueueNavigation({
  previous,
  next,
  previousShortcut,
  nextShortcut,
  onPrevious,
  onNext,
}: {
  previous: QueueNeighbour | null;
  next: QueueNeighbour | null;
  previousShortcut: string | null;
  nextShortcut: string | null;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const gt = useGT();
  const tooltip = (heading: string, neighbour: QueueNeighbour | null) => (
    <span className="flex max-w-72 flex-col">
      <span>{heading}</span>
      {neighbour === null ? null : (
        <span className="truncate text-muted-foreground">
          #{neighbour.number} {neighbour.title}
        </span>
      )}
    </span>
  );
  return (
    <div className="flex shrink-0 items-center">
      <SharedTooltipTrigger
        side="bottom"
        label={tooltip(
          previousShortcut
            ? gt("Previous in queue ({shortcut})", { shortcut: previousShortcut })
            : gt("Previous in queue"),
          previous,
        )}
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={previous === null}
            aria-label={gt("Previous in queue")}
            onClick={onPrevious}
          >
            <ChevronUpIcon aria-hidden className="size-4" />
          </Button>
        }
      />
      <SharedTooltipTrigger
        side="bottom"
        label={tooltip(
          nextShortcut
            ? gt("Next in queue ({shortcut})", { shortcut: nextShortcut })
            : gt("Next in queue"),
          next,
        )}
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={next === null}
            aria-label={gt("Next in queue")}
            onClick={onNext}
          >
            <ChevronDownIcon aria-hidden className="size-4" />
          </Button>
        }
      />
    </div>
  );
}
