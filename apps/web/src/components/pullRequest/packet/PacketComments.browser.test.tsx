import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type ReviewCommentThread,
  type ReviewPacket,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { ChangeCommentsView } from "~/state/reviewComments";

import { act, render } from "../../../../test/render";

const HEAD = "b".repeat(40);
const IMAGE = `sha256:${"1".repeat(64)}`;
const OWNER = ThreadId.make("thread-owner");
// A 400x200 picture, so a drag across it has a size in screen pixels.
const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="gray"/></svg>')}`;

const state = vi.hoisted(() => ({
  comments: null as unknown as import("effect/reactivity").Atom.Writable<
    import("~/state/reviewComments").ChangeCommentsView
  >,
  create: vi.fn(),
  send: vi.fn(),
  reply: vi.fn(),
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: PICTURE }),
}));
vi.mock("~/state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const none = Atom.make([]);
  return { environmentThreadShells: { environmentThreadsAtom: () => none } };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { run: (value: unknown) => Promise<unknown> }) => command.run,
}));
vi.mock("~/state/reviewComments", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { create } = await import("zustand");
  const allowed = Atom.make(true);
  const command = (run: (value: unknown) => Promise<unknown>) => ({
    run,
    permissionAtom: () => allowed,
  });
  const target = Atom.make(
    AsyncResult.success({
      candidates: [
        { threadId: "thread-owner", projectId: "project", title: "Fix the bag", match: "branch" },
      ],
    }),
  );
  return {
    reviewCommentEnvironment: {
      create: command((value) => state.create(value)),
      edit: command(async () => AsyncResult.success({ comment: null })),
      remove: command(async () => AsyncResult.success({ comment: null })),
      reply: command((value) => state.reply(value)),
      setResolved: command(async () => AsyncResult.success({ comment: null })),
      send: command((value) => state.send(value)),
      sendTarget: () => target,
    },
    useChangeComments: () => useAtomValue(state.comments),
    useReviewCommentDrafts: create<{
      drafts: Record<string, string>;
      marks: Record<string, unknown>;
      setDraft: (key: string, text: string) => void;
      setMark: (key: string, mark: unknown) => void;
      clearDraft: (key: string) => void;
    }>()((set) => ({
      drafts: {},
      marks: {},
      setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
      setMark: (key, mark) => set((s) => ({ marks: { ...s.marks, [key]: mark } })),
      clearDraft: (key) =>
        set((s) => {
          const { [key]: _d, ...drafts } = s.drafts;
          const { [key]: _m, ...marks } = s.marks;
          return { drafts, marks };
        }),
    })),
  };
});

import { CommentThreadList, PacketCommentsProvider, usePacketComments } from "./PacketComments";
import { PacketMediaRow } from "./PacketMedia";
import { PacketMediaViewer } from "./PacketMediaViewer";
import { PacketSendBar } from "./PacketSendBar";
import { packetVisuals } from "./reviewPacket.logic";

const packet = {
  schema: 1,
  change: { repository: "acme/app", branch: "bag", base: "main" },
  revision: { base: "a".repeat(40), head: HEAD, recordedAt: "2026-11-01T00:00:00Z" },
  status: { verdict: "pass" },
  claims: [
    {
      id: "bag",
      title: "Bag panel",
      statement: "The bag opens.",
      result: "seen",
      evidence: [{ id: "shot", kind: "image", media: IMAGE }],
      paths: [],
    },
  ],
  blockers: [],
  notes: [],
  media: [
    { id: IMAGE, file: "shot.svg", type: "image/svg+xml", bytes: 1, width: 400, height: 200 },
  ],
} as unknown as ReviewPacket;

const change = { host: "github.com", repository: "acme/app", branch: "bag" };

const person = (id: string, text: string, sentAt: string | null) => ({
  id,
  author: "person" as const,
  text,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  sentAt,
  sentToThreadId: sentAt === null ? null : OWNER,
});

const loaded = (threads: ReadonlyArray<ReviewCommentThread>, updatedAt: number) => ({
  data: {
    threads,
    counts: { pending: 0, open: 0, answered: 0, resolved: 0, unsent: 0 },
    latestHead: HEAD,
    updatedAt,
    complete: true,
  },
  waiting: false,
  failure: null,
});

function setup(threads: ReadonlyArray<ReviewCommentThread>) {
  state.comments = Atom.make<ChangeCommentsView>(loaded(threads, 0));
  state.create.mockReset();
  state.send.mockReset();
  state.reply.mockReset();
}

function Packet() {
  const visuals = packetVisuals(packet.claims[0]!.evidence, packet.media);
  return (
    <PacketCommentsProvider
      environmentId={EnvironmentId.make("env")}
      change={change}
      packet={packet}
    >
      <PacketMediaRow
        environmentId={EnvironmentId.make("env")}
        visuals={visuals}
        name="Bag panel"
        claimId="bag"
      />
      <ClaimThreads />
      <PacketSendBar checkout={null} />
      <PacketMediaViewer />
    </PacketCommentsProvider>
  );
}

function ClaimThreads() {
  const model = usePacketComments();
  return <CommentThreadList threads={model.layout.byClaim.get("bag") ?? []} />;
}

async function drag(layer: Element, from: [number, number], to: [number, number]) {
  const box = layer.getBoundingClientRect();
  const at = ([x, y]: [number, number]) => ({
    clientX: box.left + x * box.width,
    clientY: box.top + y * box.height,
  });
  const pointer = { bubbles: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0 };
  // One event per act, so each handler sees the drag the previous one started.
  for (const [type, point, buttons] of [
    ["pointerdown", from, 1],
    ["pointermove", to, 1],
    ["pointerup", to, 0],
  ] as const) {
    await act(() =>
      layer.dispatchEvent(new PointerEvent(type, { ...pointer, buttons, ...at(point) })),
    );
  }
}

it("a region drawn on a screenshot becomes a not-sent comment there, and Send delivers it to the named thread", async () => {
  setup([]);
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const created: ReviewCommentThread = {
    id: "rc_0000000000000001",
    anchor: {
      kind: "image-region",
      packetHead: HEAD,
      claimId: "bag",
      media: IMAGE,
      region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    },
    state: "pending",
    outdated: false,
    entries: [person("re_0000000000000001", "Stack the rows.", null)],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    resolvedAt: null,
  };
  state.create.mockResolvedValue(AsyncResult.success({ comment: created }));
  state.send.mockResolvedValue(
    AsyncResult.success({
      _tag: "sent",
      threadId: OWNER,
      messageId: "message:1",
      comments: 1,
      entries: 1,
      delivery: "queued",
      candidates: [],
    }),
  );
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Packet />
    </RegistryContext.Provider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Open Bag panel" }));
  const layer = await vi.waitFor(() => {
    const found = document.querySelector("[data-packet-region-layer]");
    if (found === null) throw new Error("no region layer yet");
    return found;
  });
  await vi.waitFor(() => expect(layer.getBoundingClientRect().height).toBeGreaterThan(50));
  await drag(layer, [0.25, 0.25], [0.75, 0.75]);
  await expect.element(page.getByText("New comment on the marked area")).toBeVisible();
  await userEvent.type(page.getByLabelText("Comment on this screenshot"), "Stack the rows.");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  expect(state.create).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      ...change,
      text: "Stack the rows.",
      anchor: {
        kind: "image-region",
        packetHead: HEAD,
        claimId: "bag",
        media: IMAGE,
        region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      },
    },
  });
  await expect.element(page.getByRole("button", { name: "Comment 1" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Close" }));
  await expect.element(screen.getByText("1 comment not sent")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Fix the bag" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  expect(state.send).toHaveBeenCalledWith({
    environmentId: "env",
    input: { ...change, threadId: OWNER, source: "web" },
  });
  await expect.element(screen.getByText("Waiting on agent").first()).toBeVisible();
  await expect.element(screen.getByText("It will read them after its current turn.")).toBeVisible();
});

it("an agent's answer arriving flips the comment to Answered and keeps a half-typed follow-up", async () => {
  const sent: ReviewCommentThread = {
    id: "rc_0000000000000002",
    anchor: { kind: "claim", packetHead: HEAD, claimId: "bag" },
    state: "open",
    outdated: false,
    entries: [person("re_0000000000000002", "Show the weight.", "2026-11-01T00:00:01Z")],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    resolvedAt: null,
  };
  setup([sent]);
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Packet />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("Waiting on agent")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  await userEvent.type(screen.getByLabelText("Reply to this comment"), "And the cap");

  await act(() =>
    registry.set(
      state.comments,
      loaded(
        [
          {
            ...sent,
            state: "answered",
            entries: [
              ...sent.entries,
              {
                id: "re_0000000000000003",
                author: "agent",
                kind: "fixed",
                text: "The total weight is at the top now.",
                fixedIn: "abc1234",
                threadId: OWNER,
                createdAt: "2026-11-01T00:01:00Z",
              },
            ],
          },
        ],
        // Newer than anything this client wrote, as a refresh after the answer is.
        Number.MAX_SAFE_INTEGER,
      ),
    ),
  );

  await expect.element(screen.getByText("Answered", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("The total weight is at the top now.")).toBeVisible();
  await expect.element(screen.getByLabelText("Reply to this comment")).toHaveValue("And the cap");
});
