# Play a branch with the project's harness

A project can name one **harness** executable in its `t3.json`. T3 Code uses it to set the project up on a machine, ready each worktree, and run a session of the real app, such as a game, that you play in T3 Code or an agent playtests. After a session, the harness's review packet is stored on the change, so the pull request opens on its evidence.

```json
{
  "harness": "harness/gw"
}
```

The path is relative to the checkout's root, and it must name a file inside the checkout.

## Approve the harness

The harness is the project's own code and runs on the environment's machine with your permissions, outside any agent sandbox. T3 Code runs it only after a person approved the path for that project, under **Harness** in the project's settings or when you first play a branch. If a branch's `t3.json` names a different path, you are asked again. Approval covers the path, not the file's contents: playing a branch runs that branch's harness.

Agents can start sessions only from a thread in Full access, as with the project's other commands. An organization's [managed policy](./managed-policy.md) can turn the harness off (`worktreeLayoutCommands: false`).

## Set the machine up

Under **Harness** in the project's settings, **Check** lists what the harness needs on this machine and how to install anything missing. **Run setup** installs it. Setup can take a long time; you can leave the page while it runs.

## Play a branch

On a thread with its own worktree, or on a pull request whose branch has one, choose **Play this branch**. T3 Code readies the checkout, starts a session and shows its stream beside a **Mark** button, a note field and **Stop**.

- **Network.** _Direct_ (the default) is the fastest, but the game, its server and the stream server can make outbound connections, and T3 Code says so while it runs. _Isolated_ allows no outbound network and records the session.
- **Marks.** A mark notes a moment, or with **last N seconds** what just happened, so it becomes evidence in the packet. Only recorded sessions take marks, so choose Isolated when you want them.
- **Keyboard and pointer.** When T3 Code is served over HTTPS (for example with Tailscale Serve), the stream gets Escape and the clipboard. Over plain HTTP, Escape releases the pointer instead of reaching the game. Use the fullscreen button for keyboard lock.
- **Network reach.** The video goes straight from the machine to your browser, so your device must be able to reach the machine's address, such as over your tailnet.

**Stop** ends the session, then T3 Code assembles and stores its packet. A running session shows an indicator on its thread, so you can find it again from anywhere. The mobile app shows the session's state with **Mark** and **Stop**; play the stream from the desktop or web app.

## Run a playtest

**Run playtest** asks the thread's agent to start a hidden, recorded session, play the change's claims, mark what it sees and stop the session, which stores the packet.

## For harness authors

T3 Code runs the harness in the checkout with a verb and reads one JSON document from its standard output. The exit code reports the outcome, and a failure prints `{"ok": false, "error": "..."}`.

| Verb                                                                   | Runs                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `doctor --json`                                                        | Lists dependencies with their state and instructions.                                                                          |
| `setup`                                                                | Installs what `doctor` reports missing.                                                                                        |
| `prepare`                                                              | Readies a checkout. T3 Code runs it when a worktree is created and before each session, so make it quick when nothing changed. |
| `session start --by person\|agent [--streamed] --net isolated\|direct` | Starts a session and answers with how to attach and the recording path.                                                        |
| `session status`, `session stop`                                       | Report on and end the running session.                                                                                         |
| `mark [--last <seconds>] -- <note>`                                    | Marks the running session. Fail if the session is not recorded.                                                                |
| `packet`                                                               | Assembles the packet folder (`packet.json` and its media).                                                                     |

A verb that leaves something running, such as a session, must start it in its own process session, so it outlives the verb.

Every verb gets these variables:

- `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH`: the project folder and the checkout.
- `T3CODE_CACHE_PATH`: one folder per project on this machine, shared by its checkouts, for installed tools and downloads.
- `T3CODE_OUTPUT_PATH`: one folder per checkout, outside the checkout, where results and recordings go. T3 Code deletes it when the worktree is removed.
- `T3CODE_SLOT`: a number from 0 to 99, unique among the project's live checkouts, so sessions of several checkouts can run at once. A streamed session listens on port 5900 plus the slot.
- `T3CODE_STREAM_PATH`: the URL path to serve the stream page under. T3 Code shows the stream from its own origin, signing in to it for you, so the browser never sees the session's password.
