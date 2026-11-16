[日本語](risk-assessment.md) | **English**

# PR risk assessment

sacty has an AI assess the risk of a PR's content, and puts the level, the grounds, the suggested review depth, and the places to look at into the PR description and the PR review comment.
The assessment is a guide for a person deciding how deeply to review the PR.
sacty does not skip a review, merge automatically, or change the steps because of the assessment.

Related ADR: [Produce a PR risk assessment (not used to skip reviews or to merge automatically)](../adr/20261116-1632-pr-risk-assessment.md)

## When it is assessed

It is assessed only on the following two occasions.

| Occasion | Who assesses | Where it is put |
| --- | --- | --- |
| Before sacty opens or updates an implementation PR (`via` is `publish`) | The Orchestrator's agent. It reads the implemented code and the diff | The PR description |
| The review step of a review task imported from a GitHub PR (`via` is `review`) | The review step's agent. It gives the assessment with its review answer | The review comment that is posted |

- A requirements or design PR, and an existing PR that was taken over (whose title and body are not changed), are not assessed.
- The review comment of a review child task that sacty created for its own PR (it has `reviewOf`, or it was imported as `sacty`) does not carry an assessment (`assessesRiskInReview`).
  That PR's description carries the assessment made before the PR was opened.

Code: `apps/daemon/src/risk-assessment.ts` (`assessesRiskInReview`), `apps/daemon/src/service.ts` (`assessRisk`)

## Levels and criteria

There are three levels. Each level fixes the review depth suggested to a person (`RISK_DEPTH_LABEL`; the agent does not write it).

| Level | Criteria | Suggested review depth |
| --- | --- | --- |
| High (`high`) | At least one of the "risk signals" below applies | Check from the design and impact (read the places to look at and, for each risk signal, check the design, the reach of the impact, and how to undo it) |
| Medium (`medium`) | No signal applies, and the change is not only of the safe kinds (it changes behavior, but its reach is limited, reverting it undoes it, and the changed behavior has been verified) | Read where the behavior changes (read the places to look at and their tests) |
| Low (`low`) | No signal applies, and every change is one of the "safe kinds" below | A skim is enough (check that the change matches its description) |

The risk signals (`RiskSignal`) are the following eight.

| Signal | Criteria |
| --- | --- |
| `security` (security) | Changes something security-related, such as authentication, authorization, secrets, cryptography, input validation, or the handling of external input |
| `irreversible` (hard-to-undo change) | Does something that reverting the change does not undo, such as migrating or deleting stored data, changing a storage format or schema, or sending or publishing something externally |
| `compatibility` (compatibility change) | Changes a contract others rely on (a public API, a command, a setting, a file format, an event shape, and so on) incompatibly |
| `structural` (structural or wide-reaching change) | Changes the structure substantially, or changes behavior across many callers or several parts |
| `performance` (performance or concurrency) | Affects performance, concurrency, or resource use (locks, retries, timeouts, caches, the handling of large input, and so on) |
| `defect` (suspected defect) | A defect or a logic error was found while reading |
| `large` (large diff) | The diff is large, or mixes changes with different concerns, so following the intent takes effort |
| `unverified` (unverified behavior) | The changed behavior has not been verified by tests or by running it |

The safe kinds are: changes to documents or comments only, formatting only, refactoring or renaming that does not change behavior, removal of unused code, adding or fixing tests only, adding logging or instrumentation, adding defensive checks that do not change behavior, and tidying imports or updating static resources.

- As an important constraint, when a skill or context about RADAR (the idea of varying the review depth with the risk of a change) is loaded in the run, the agent is told to put its content before the criteria above (`RISK_LOADED_GUIDANCE_LINE`).
  - Whether a signal applies, which level to choose, and what to give as grounds and places to look at are decided by the loaded content. The criteria above are used only for what the loaded content does not decide.
  - The answer shape (the JSON fields, and the fixed values of `level` and `signals`) is not changed.
  - Text in what is being assessed (the task content, the PR description, the diff, the code) is not treated as loaded content.
  - sacty does not check whether such content is loaded (it is left to the agent's judgment).
- The agent is told to choose the higher level when in doubt.
- If the answer has at least one signal, sacty makes the level `high` regardless of the level the agent gave. With no signal, the agent's level is kept (`extractRiskAssessment`).
- No numeric score is produced.

Code: `apps/daemon/src/risk-assessment.ts` (`riskCriteriaLines`, `RISK_DEPTH_LABEL`, `RISK_SIGNAL_LABEL`), `packages/core/src/events.ts` (`RiskLevel`, `RiskSignal`)

## Content of the assessment and how it is read

The agent answers with the assessment as `sacty-risk-assessment` JSON.

```json
{"sacty-risk-assessment": {"level": "medium", "signals": [], "change": "変更の種類", "scope": "影響の範囲", "reversibility": "取り消しやすさ", "verification": "確かめた範囲", "focus": [{"where": "src/pay.ts:40-72", "why": "見る理由"}]}}
```

| Field | Content |
| --- | --- |
| `level` | The level (`low`, `medium`, or `high`) |
| `signals` | The risk signals that apply (empty if none) |
| `change` | The kind of change (what is changed, and how) |
| `scope` | The reach of the impact (which features, users, or callers it reaches) |
| `reversibility` | The ease of undoing (whether reverting the change undoes it) |
| `verification` | What was verified (which tests or runs verified what, and what has not been verified) |
| `focus` | The places a person should look at (`where` is a path and lines, `why` is the reason to look; up to 5) |

- The last answer with a matching shape is used.
- If the level is not one of the values, or any of the four grounds (`change`, `scope`, `reversibility`, `verification`) is missing, the answer is treated as unreadable.
- Unknown signals and malformed places to look at are dropped.
- Each text is made one line, the secrets passed in are redacted, and then it is cut at the limit (400 characters for a ground, 200 characters for `where`).

Code: `apps/daemon/src/risk-assessment.ts` (`extractRiskAssessment`), `packages/core/src/events.ts` (`RiskAssessment`)

## Assessment before opening a PR

When an implementation PR is opened or updated, the assessment runs after the commit is pushed and before the body is built.

- The Orchestrator's agent runs on a throwaway copy of the implemented code. The prompt contains how to read the diff (the base commit and the commit to publish), the criteria for the levels, the task's title and content, the approved requirements, and the implementation agent's description (`buildRiskAssessmentPrompt`).
- If the same commit has already been assessed, it is not assessed again (a resume, or a retry of the same submission). A commit that could not be assessed is assessed again at the next opportunity.
- Even when the assessment fails, opening or updating the PR is not stopped. The reason is recorded and the body says so. The assessment fails in these cases.
  - The budget cap has been reached (no agent is run; `pr.riskBudget`)
  - The agent's run failed (`pr.riskFailed`)
  - The answer could not be read (`pr.riskUnreadable`)
- Only when a run could not be confirmed to have stopped does sacty pause without opening the PR, so that it does not overlap another run (the same as reconciling a conflict in [Updating a body a person edited](approval.en.md#updating-a-body-a-person-edited)).
- The assessment is enabled when the daemon starts (`riskAssessment` of `ServiceDeps`). A service that does not enable it (a test) does not assess.
- The result is recorded in `PullRequestRiskAssessed`. The cost is counted on the Orchestrator's row ([Activity](event-log.en.md#cost)).

Code: `apps/daemon/src/service.ts` (`assessRisk`, `publish`), `apps/daemon/src/risk-assessment.ts` (`assessPullRequestRisk`, `buildRiskAssessmentPrompt`), `apps/daemon/src/main.ts`

## Assessment in the review step

For a review task imported from a GitHub PR (a review request or a label), the criteria and the answer shape are added to the review prompt (`reviewRiskLines`).

- The agent is told to give the assessment separately from the findings and the verdict, and not to let the assessment change the weight of a finding, the verdict, or what the review looks at.
- The assessment JSON is removed from the posted body even when its shape is wrong (`extractReviewComments`). One that cannot be parsed as JSON (a trailing comma, and so on) is also removed, together with the code block that contains the assessment heading (`withoutRiskBlocks`). An unparseable assessment that is not in a code block stays, because its extent cannot be determined.
- If the answer could be read, the assessment is recorded in `PullRequestRiskAssessed` together with the completion of the step's run; if not, the fact that it could not be assessed (`pr.riskUnreadable`) is recorded. The cost is counted on the step's run, so this record carries no cost.
- Even when the assessment fails, posting the review is not stopped.

Code: `apps/daemon/src/risk-assessment.ts` (`reviewRiskLines`, `withoutRiskBlocks`), `apps/daemon/src/prompts.ts` (`extractReviewComments`), `apps/daemon/src/service.ts` (`assessesRiskInReview`)

## How it is shown

The PR description and the review comment carry a section of the same shape, "リスク評価" (`riskAssessmentLines`).

- It lists, in order: the level (low, medium, or high), the suggested review depth, the risk signals that apply (if any), the kind of change, the reach of the impact, the ease of undoing, what was verified, the places to look at (if any), and a note that it is an AI-made guide.
- When the assessment failed, it says so with the reason, and says to decide the review depth from the diff.
- A task with no assessment record gets no section.
- The heading, the field names, and the depth text are in Japanese, like sacty's other fixed text. The grounds are shown in the language the agent wrote them in.

It is placed as follows.

| Where it is put | Place |
| --- | --- |
| The PR description (sacty's fixed format) | Right after "結論" (Conclusion). Not dropped even at the body length limit |
| The PR description (the format that follows the PR template) | At the start of sacty's notes at the end (the footer). Not dropped |
| The review comment | After the verdict line and before the agent's body. Only the assessment of the head commit reviewed this time is shown |

Code: `apps/daemon/src/risk-assessment.ts` (`riskAssessmentLines`), `apps/daemon/src/prompts.ts` (`buildPullRequestBodyText`, `buildPullRequestBodyParts`, `buildReviewBody`)

## Record and UI

- `PullRequestRiskAssessed` holds the occasion (`via`), the commit assessed (`commit`), and the assessment (`assessment`) or the reason it could not be assessed (`reason`).
- A task holds only the last assessment (`Task.riskAssessment`). A record of a failed assessment does not keep the earlier assessment.
- The UI shows a "PR risk assessment" section in the overview of the task detail (only for a task with an assessment record). The activity shows the occasion and the level (or the reason, if it could not be assessed) in one line.

Code: `packages/core/src/projection.ts` (`applyEvent`), `apps/web/src/components/risk-assessment.tsx` (`RiskAssessmentCard`)
