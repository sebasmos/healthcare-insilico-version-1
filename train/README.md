# Training exports

The platform does not train models. It produces data you can train on elsewhere. This page describes the files and the one contract you must keep.

## The contract: train and run with the same history window

Every training export accepts `?window=<n>`. With a window, each action in the file is paired with only the last `n` (action, observation) turns that came before it. Without one, each action is paired with everything that came before it.

**Use the same `n` at inference.** If you train on `window=4` and then run the model with ten turns of context (or with one), it sees inputs unlike anything it was trained on, and its behaviour is not what the training reward described. The window you used is written into the first line of every file as `windowSize`, so it travels with the data.

`window=0` means "no history": the model sees only the scenario and task.

## Getting the files

Start the server, load cases and run some attempts (Agent Ops, "Training data"). Then:

```
curl -s "http://localhost:3000/agent-ops/export/sft.jsonl?window=4" -o sft.jsonl
curl -s "http://localhost:3000/agent-ops/export/preferences.jsonl?window=4" -o preferences.jsonl
curl -s "http://localhost:3000/agent-ops/export/trajectories.jsonl?window=4" -o trajectories.jsonl
curl -s "http://localhost:3000/agent-ops/episodes.jsonl" -o episodes.jsonl
```

Add `&agentId=<id>` or `&version=<v>` to limit an export to one agent or version.

## What every file has in common

- JSON Lines: one JSON object per line.
- **Line 1 is a manifest**, not data: `{ "manifest": true, "export", "exportedAt", "agentId", "version", "windowSize", "splitFilter", "episodeCount", "lineCount", "evalSplitExcluded", "rewardVersion", "deidentified", "removedFields" }`. Skip it when loading rows; keep it with the dataset.
- **Evaluation-only cases are never included.** The three training exports refuse `split=eval`. `episodes.jsonl` is raw episode data, not a training export; it leaves evaluation cases out unless you ask with `?split=eval`, and then the manifest says `"evalSplitExcluded": false`.
- **De-identified.** Patient names, identifiers, contact details and addresses are removed; dates of birth are cut to the year; clinician display names are removed. The manifest counts what was removed. The data is synthetic to begin with; this step is a second line of defence, not a licence to load real data.
- **Logged.** Each download writes a TraceStep and an AuditEvent.
- Rewards are computed with the reward weights saved at the time of the download (`rewardVersion`). Changing the weights changes which attempt is "best" and which pairs appear.

## The files

### `sft.jsonl`: imitate the best attempt

For each training case, the highest-reward attempt, one line per action:

```
{ "episodeId", "caseId", "title", "scenario", "task", "reward", "turn",
  "history": [ { "action", "observation" }, ... ],
  "action": { "tool": "read" | "search" | "create" | "update", ... },
  "reasoning": "why the agent took this action" }
```

`history` is cut to the window. `action` is the target. Requests the server refused are kept in `history` (so the model sees the refusal) but are never targets.

### `preferences.jsonl`: better versus worse

Pairs of attempts at the same case where one scored higher:

```
{ "caseId", "title", "scenario", "task", "margin",
  "preferred": { "episodeId", "reward", "trajectory": [ ... ] },
  "rejected":  { "episodeId", "reward", "trajectory": [ ... ] } }
```

Trajectories are cut to the last `window` turns. Pairs never cross cases.

### `trajectories.jsonl`: every step with its reward

Every training attempt, step by step:

```
{ "episodeId", "caseId", "seed", "totalReward",
  "steps": [ { "t", "history": [ ... ], "action", "reasoning", "observation", "reward" }, ... ] }
```

A step that wrote a record satisfying a verifier check gets that check's share of the reward. A refused request gets the safety penalty. Whatever is left is placed on the last step, so the step rewards always add up to `totalReward`.

### `episodes.jsonl`: raw episodes

Every episode as stored (attempts, shadow comparisons, clinician decisions) with its checks, reward breakdown and outcome-over-time results. No window, no truncation.

## Things to keep in mind

- A reward is a proxy. A high reward is not evidence that a policy is clinically safe. Safety violations are a separate component so they cannot hide inside a total; check them directly.
- The ready-made scenarios use an unverified starter set of codes. Replace them with verified terminology before drawing conclusions from the data.
- The Workup Planner reference agent is a rule table that deliberately varies between attempts. Data from it exercises the pipeline; it does not teach clinical reasoning.
- Seeds make attempts replayable: the same agent version, case and seed give the same attempt.
