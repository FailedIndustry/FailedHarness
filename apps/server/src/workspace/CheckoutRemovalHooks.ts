import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * What must happen before a checkout's files go, whichever code removes it: a harness session
 * started there can only be stopped while its executable still exists. Removers read this with
 * `Effect.serviceOption` at construction, so one built without it (as in tests) removes plainly.
 */
export class CheckoutRemovalHooks extends Context.Service<
  CheckoutRemovalHooks,
  {
    readonly register: (hook: (checkout: string) => Effect.Effect<void>) => Effect.Effect<void>;
    /** Runs every hook for `checkout`; a hook never fails the removal. */
    readonly beforeRemove: (checkout: string) => Effect.Effect<void>;
  }
>()("t3/workspace/CheckoutRemovalHooks") {}

export const layer = Layer.sync(CheckoutRemovalHooks, () => {
  const hooks: Array<(checkout: string) => Effect.Effect<void>> = [];
  return CheckoutRemovalHooks.of({
    register: Effect.fn("CheckoutRemovalHooks.register")(function* (hook) {
      hooks.push(hook);
    }),
    beforeRemove: Effect.fn("CheckoutRemovalHooks.beforeRemove")(function* (checkout) {
      for (const hook of hooks) yield* hook(checkout).pipe(Effect.ignoreCause);
    }),
  });
});

/** The hooks a remover was built with, or nothing to run. */
export const beforeRemoveFrom = Effect.map(
  Effect.serviceOption(CheckoutRemovalHooks),
  (hooks) => (checkout: string) =>
    hooks._tag === "Some" ? hooks.value.beforeRemove(checkout) : Effect.void,
);
