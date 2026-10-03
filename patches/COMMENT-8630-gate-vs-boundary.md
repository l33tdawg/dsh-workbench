*Posted 2026-10-03 as [comment 18727962](https://github.com/deepseek-ai/deepseek-harness/discussions/8630#discussioncomment-18727962) on [discussion #8630](https://github.com/deepseek-ai/deepseek-harness/discussions/8630).*

Thanks — worth separating the layers, because these are complements rather than substitutes.

The report is about **enforcement**: under `read-only` and `workspace-write`, the confined process can still reach the network. The fence denies egress inside the sandbox — `--unshare-net` for bwrap, `(deny network*)` under Seatbelt — so it holds for the whole process tree whatever the command text says.

A `tools/pre-execute` gate classifies what the agent **asks for**. The read half of your plugin is genuinely additive here: `denyReadPaths` addresses something this report does not, since the fence is egress-only and says nothing about reads.

Where they differ is the case where the network act is not in the tool call at all — a script the command merely starts, or I/O from a process the harness never dispatched. A gate sees the request; the sandbox sees the syscall. Both layers are wanted.
