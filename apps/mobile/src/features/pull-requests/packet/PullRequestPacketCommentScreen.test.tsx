import { RegistryContext } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type ButtonProps = { label: string; loading?: boolean; disabled?: boolean; onPress: () => void };
const mocks = vi.hoisted(() => ({
  goBack: vi.fn(),
  reply: vi.fn<(commentId: string, text: string) => Promise<boolean>>(),
  button: null as ButtonProps | null,
  changeText: (_text: string) => {},
  value: "",
}));
vi.mock("react-native", () => ({ View: ({ children }: { children: ReactNode }) => children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("expo-video", () => ({ useVideoPlayer: () => null, VideoView: () => null }));
vi.mock("../../../state/assets", () => ({ useAssetUrlState: () => ({ _tag: "Initial" }) }));
vi.mock("../../../state/reviewComments", async () => {
  const { Atom } = await import("effect/reactivity");
  // Like the real drafts, the words outlive the sheet.
  return {
    reviewCommentDraftFamily: Atom.family((_key: string) =>
      Atom.make<string | null>(null).pipe(Atom.keepAlive),
    ),
  };
});
vi.mock("./usePacketComments", () => ({
  useReviewCommentActions: () => ({ reply: mocks.reply }),
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: { value: string; onChangeText: (text: string) => void }) => {
    mocks.changeText = props.onChangeText;
    mocks.value = props.value;
    return null;
  },
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    mocks.button = props;
    return null;
  },
}));
vi.mock("../PullRequestSheetContent", () => ({
  PullRequestSheetContent: (props: { children: ReactNode; footer: ReactNode }) => (
    <>
      {props.children}
      {props.footer}
    </>
  ),
}));

import { AtomRegistry } from "effect/reactivity";
import { PullRequestPacketCommentScreen } from "./PullRequestPacketCommentScreen";

it("keeps a reply's words after a failed save, and starts the next reply empty once one saves", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const params = {
    environmentId: "environment",
    host: "github.com",
    repository: "owner/repo",
    branch: "agent/fix",
    intent: { kind: "reply" as const, commentId: "rc_0000000000000001" },
    context: "Bag holds items",
  };
  const mount = () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <PullRequestPacketCommentScreen route={{ params } as never} />
        </RegistryContext.Provider>,
      ),
    );
    return { [Symbol.dispose]: () => act(() => root.unmount()) };
  };

  {
    using _sheet = mount();
    act(() => mocks.changeText("Still drops the sword"));
    mocks.reply.mockResolvedValueOnce(false);
    await act(async () => mocks.button?.onPress());
    expect(mocks.goBack).not.toHaveBeenCalled();
  }
  {
    using _sheet = mount();
    expect(mocks.value).toBe("Still drops the sword");
    mocks.reply.mockResolvedValueOnce(true);
    await act(async () => mocks.button?.onPress());
    expect(mocks.reply).toHaveBeenLastCalledWith("rc_0000000000000001", "Still drops the sword");
    expect(mocks.goBack).toHaveBeenCalledTimes(1);
  }
  using _next = mount();
  expect(mocks.value).toBe("");
  expect(mocks.button?.disabled).toBe(true);
});
