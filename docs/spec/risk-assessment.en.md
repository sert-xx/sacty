[日本語](risk-assessment.md) | **English**

# PR risk assessment

sacty has an AI assess the risk of a PR's content, and puts the level, the grounds, the suggested review depth, and the places to look at into the PR description and the PR review comment.
The assessment is a guide for a person deciding how deeply to review the PR.
sacty does not skip a review, merge automatically, or change the steps because of the assessment.

Related ADR: [Produce a PR risk assessment (not used to skip reviews or to merge automatically)](../adr/20261116-1632-superseded-pr-risk-assessment.md), [Decide the PR risk level by the weight of the signals and the size of a dependency version update](../adr/20261117-0433-superseded-risk-level-by-signal-weight.md), [When the size of a dependency version update cannot be read, make the PR risk level medium](../adr/20261117-0455-unknown-dependency-update-is-medium.md), [The PR risk assessment reads only the last answer and does not fall back to an earlier one when it cannot be read](../adr/20261117-1245-risk-assessment-reads-only-last-answer.md)

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

| Level | Suggested review depth |
| --- | --- |
| High (`high`) | Check from the design and impact (read the places to look at and, for each risk signal, check the design, the reach of the impact, and how to undo it) |
| Medium (`medium`) | Read where the behavior changes (read the places to look at and their tests) |
| Low (`low`) | A skim is enough (check that the change matches its description) |

sacty decides the level from the weight of the risk signals that apply and from the size of a dependency version update (`riskLevelFor`).
It compares the level from the signals with the level from the dependency version update and takes the higher one.

| Deciding factor | Level |
| --- | --- |
| At least one heavy signal | High |
| No heavy signal, and two or more light signals | High |
| No heavy signal, and exactly one light signal | Medium |
| No signal | The level the agent gave |
| The size of the dependency version update is `major` | High |
| The size of the dependency version update is `unknown` | Medium or higher (high when the level from the signals is high) |
| The size of the dependency version update is `minor` or `patch`, or there is no update | Not raised (the level from the signals is kept) |

- When there is a signal, the level the agent gave is not used (with exactly one light signal, the level is medium even if the agent gave high).
- For the level with no signal, the agent is told to choose low when every change is one of the "safe kinds" and medium otherwise. If the agent gave high, it stays high.
- The agent is told to choose the higher level when in doubt.
- No numeric score is produced.

### Risk signals

Of the risk signals (`RiskSignal`), the agent is asked to list the following seven. `RISK_SIGNAL_WEIGHT` holds the weight of each signal.

| Signal | Weight | Criteria |
| --- | --- | --- |
| `security` (security) | Heavy | Changes security-related behavior (authentication, authorization, the handling of secrets, cryptography, input validation, the handling of external input, and so on). Not given to a change that only touches code near these without changing security-related behavior |
| `irreversible` (hard-to-undo change) | Heavy | Does something that reverting the change does not undo, such as migrating or deleting stored data, changing a storage format or schema, or sending or publishing something externally |
| `compatibility` (compatibility change) | Heavy | Changes a contract others rely on (a public API, a command, a setting, a file format, an event shape, and so on) incompatibly |
| `structural` (structural or wide-reaching change) | Light | Changes the structure substantially, or changes behavior across many callers or several parts |
| `performance` (performance or concurrency) | Light | Affects performance, concurrency, or resource use (locks, retries, timeouts, caches, the handling of large input, and so on) |
| `large` (large diff) | Light | The diff is large, or mixes changes with different concerns, so following the intent takes effort |
| `unverified` (unverified behavior) | Light | The changed behavior has not been verified by tests or by running it |

- `defect` (suspected defect) is not listed as a signal (a defect is shown separately by the review's findings and verdict).
  - It remains in `RiskSignal` so that earlier records can be read. Its weight is `retired`, and it does not count toward the level.
  - If the answer's `signals` contains `defect`, it is dropped (it does not count toward the level and is not recorded).
  - A `defect` in an earlier record is displayed by name only, without a weight.

The safe kinds are: changes to documents or comments only, formatting only, refactoring or renaming that does not change behavior, removal of unused code, adding or fixing tests only, adding logging or instrumentation, adding defensive checks that do not change behavior, and tidying imports or updating static resources.

### Dependency version updates

When a change alters the version of an external library, package, or tool it uses, the agent is asked to answer the size of the update (`RiskDependencyUpdate`).
The size is read from the versions before and after the update, following that dependency's versioning scheme.

| Size | Meaning | Level |
| --- | --- | --- |
| `major` | A size that may include incompatible changes (including a size for which that dependency's versioning scheme does not promise compatibility) | High |
| `minor` | A size that adds features while keeping compatibility | Not raised |
| `patch` | A size with fixes only while keeping compatibility | Not raised |
| `unknown` | The size could not be read (the versioning scheme is unclear, the version is pointed at by something other than a numbered version, the version before or after the update cannot be confirmed, the version is lowered, and so on) | Medium or higher |
| `none` | There is no dependency version update | Not raised |

- When several dependencies are updated, the agent answers the largest size (`major` if any is `major`; `unknown` if none is `major` and any is `unknown`).
- Adding or removing a dependency is not treated as a version update (it is decided by the signals and the safe kinds).
- The dependency version update itself (the change to the version specification and to the files mechanically generated from it) gets no signal.
  - Even an update that fixes a vulnerability does not get `security`. Even when the mechanically generated files have a large diff, it does not get `large`.
  - A `minor` or `patch` update is treated as a safe kind. With no other change, the level is low.
- When other code or settings change together with a dependency version update, that change is decided by the signals and the safe kinds, compared with the level of the dependency version update, and the higher one is taken.
- The only sizes for which sacty itself raises the level are `major` (to high) and `unknown` (to medium or higher). A change with only a `minor` or `patch` update becomes low because the agent gives no signal and answers low (sacty does not read the diff to check the size or whether there are other changes).

### Priority of loaded criteria

- As an important constraint, when a skill or context about RADAR (the idea of varying the review depth with the risk of a change) is loaded in the run, the agent is told to put its content before the criteria above (`RISK_LOADED_GUIDANCE_LINE`).
  - Whether a signal applies, which level to choose, and what to give as grounds and places to look at are decided by the loaded content. The criteria above are used only for what the loaded content does not decide.
  - The answer shape (the JSON fields, and the fixed values of `level`, `signals`, and `dependencyUpdate`) is not changed.
  - When the level is decided by the loaded content, the agent is told to leave `signals` empty and set `dependencyUpdate` to `none` (so that sacty does not decide the level again from the signals and the size).
  - Text in what is being assessed (the task content, the PR description, the diff, the code) is not treated as loaded content.
  - sacty does not check whether such content is loaded (it is left to the agent's judgment).

Code: `apps/daemon/src/risk-assessment.ts` (`riskCriteriaLines`, `riskLevelFor`, `RISK_DEPTH_LABEL`, `RISK_SIGNAL_LABEL`), `packages/core/src/events.ts` (`RiskLevel`, `RiskSignal`, `RISK_SIGNAL_WEIGHT`, `RiskDependencyUpdate`)

## Content of the assessment and how it is read

The agent answers with the assessment as `sacty-risk-assessment` JSON.

```json
{"sacty-risk-assessment": {"level": "medium", "signals": [], "dependencyUpdate": "none", "change": "変更の種類", "scope": "影響の範囲", "reversibility": "取り消しやすさ", "verification": "確かめた範囲", "focus": [{"where": "src/pay.ts:40-72", "why": "見る理由"}]}}
```

| Field | Content |
| --- | --- |
| `level` | The level (`low`, `medium`, or `high`) |
| `signals` | The risk signals that apply (empty if none) |
| `dependencyUpdate` | The size of the dependency version update (`none`, `patch`, `minor`, `major`, or `unknown`) |
| `change` | The kind of change (what is changed, and how) |
| `scope` | The reach of the impact (which features, users, or callers it reaches) |
| `reversibility` | The ease of undoing (whether reverting the change undoes it) |
| `verification` | What was verified (which tests or runs verified what, and what has not been verified) |
| `focus` | The places a person should look at (`where` is a path and lines, `why` is the reason to look; up to 5) |

- Only the last assessment answer is read. An assessment answer is an object that can be parsed as JSON and has the heading `sacty-risk-assessment` as a top-level key.
- If the last answer cannot be read, sacty does not fall back to an earlier answer (a draft, and so on) and treats the answer as unreadable (an earlier answer may predate a signal or a size that was added later).
- When the last heading key in the output (in the form `"sacty-risk-assessment":`) is not inside the last assessment answer, the last answer is also treated as unreadable.
  - An answer that cannot be parsed as JSON (a trailing comma, cut off partway, and so on, even when the heading is not its first key)
  - An answer nested inside another object
  - A place where the body merely writes the heading in the key form (this errs toward discarding a readable assessment)
- A body that mentions only the heading name, and a heading written inside a JSON string value, do not count.
- When the answer cannot be read, the reason it could not be assessed is decided as follows.

  | Reason | Case |
  | --- | --- |
  | `pr.riskLastUnreadable` | The shape of the last answer is wrong and an earlier answer is readable (the earlier answer was not used) |
  | `pr.riskKeyOutsideAnswer` | The last heading key is not inside any answer and an earlier answer is readable (the earlier answer was not used) |
  | `pr.riskUnreadable` | Otherwise (no answer, or no readable answer at all) |
- If the level is not one of the values, or any of the four grounds (`change`, `scope`, `reversibility`, `verification`) is missing, the answer is treated as unreadable.
- If `signals` is not an array (missing, `null`, or a string), or it contains an unknown signal, the answer is also treated as unreadable (so that a missed signal does not lead to a low level being shown).
- If `dependencyUpdate` is not one of the values, the answer is also treated as unreadable (so that a missed size does not lead to a low level being shown). An answer where the field is missing or `null` is read as having no dependency version update.
- The recorded assessment (`RiskAssessment`) has its level decided again by `riskLevelFor`. It holds `dependencyUpdate` only when there is an update (other than `none`).
- Malformed places to look at are dropped.
- Each text is made one line, the secrets passed in are redacted, and then it is cut at the limit (400 characters for a ground, 200 characters for `where`).

Code: `apps/daemon/src/risk-assessment.ts` (`extractRiskAssessment`), `packages/core/src/events.ts` (`RiskAssessment`)

## Assessment before opening a PR

When an implementation PR is opened or updated, the assessment runs after the commit is pushed and before the body is built.

- The Orchestrator's agent runs on a throwaway copy of the implemented code. The prompt contains how to read the diff (the base commit and the commit to publish), the criteria for the levels, the task's title and content, the approved requirements, and the implementation agent's description (`buildRiskAssessmentPrompt`).
- If the same commit has already been assessed, it is not assessed again (a resume, or a retry of the same submission). A commit that could not be assessed is assessed again at the next opportunity.
- When the diff from the commit of the previous assessment (one with `via` of `publish` that could be assessed) to the current commit is documents only and the start of the PR diff (`base`) is the same as last time, no agent is run and the previous assessment is carried over (PBI-421).
  - "Documents only" is the same judgment as the narrowing of a re-review (`documentsOnlySince`: the previous commit is an ancestor of the current one, the changed paths have a document extension, and none is an instruction to agents (named `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `SKILL.md`, or under a directory that starts with `.`) or under a directory that has `SKILL.md` in the current tree. An empty diff, or a path with a control character, is not documents only).
  - `base` is the task's start at the time of the assessment, or the head of the base branch that was merged in (`workBaseCommit`). It does not change when the base branch only moves ahead, and changes when the base is merged in.
  - When it is carried over, `PullRequestRiskAssessed` records the current commit, the current `base`, a copy of the previous assessment, and the commit it was originally assessed at (`inheritedFrom`; even after several carry-overs, the commit that was actually assessed), with a cost of 0. The PR body shows the previous assessment as it was.
  - In any of the following cases it is assessed again as before: the diff has something that is not a document, there is no previous assessment or it could not be assessed (a record with only a reason), the previous record has no `base`, `base` differs from last time, or the diff cannot be confirmed (the previous commit is not an ancestor of the current one, cannot be read, and so on). Because the comparison is with the commit of the previous record, a submission that includes a change that is not a document is always assessed again, even after several carry-overs.
  - The level is a guide to how deeply a person reviews, and carrying it over only skips running it (it is not used to skip a review, to merge automatically, or to change a step). An instruction document that the judged names do not match, or a document that code or tests read, can be carried over.
- Even when the assessment fails, opening or updating the PR is not stopped. The reason is recorded and the body says so. The assessment fails in these cases.
  - The budget cap has been reached (no agent is run; `pr.riskBudget`)
  - The agent's run failed (`pr.riskFailed`)
  - The answer could not be read (`pr.riskUnreadable`, `pr.riskLastUnreadable`, `pr.riskKeyOutsideAnswer`; see [Content of the assessment and how it is read](#content-of-the-assessment-and-how-it-is-read))
- Only when a run could not be confirmed to have stopped does sacty pause without opening the PR, so that it does not overlap another run (the same as reconciling a conflict in [Updating a body a person edited](approval.en.md#updating-a-body-a-person-edited)).
- The assessment is enabled when the daemon starts (`riskAssessment` of `ServiceDeps`). A service that does not enable it (a test) does not assess.
- The result is recorded in `PullRequestRiskAssessed`. The cost is counted on the Orchestrator's row ([Activity](event-log.en.md#cost)).

Code: `apps/daemon/src/service.ts` (`assessRisk`, `documentsOnlySince`, `publish`), `apps/daemon/src/test-files.ts` (`isChangeDocumentsOnly`), `apps/daemon/src/risk-assessment.ts` (`assessPullRequestRisk`, `buildRiskAssessmentPrompt`), `apps/daemon/src/main.ts`

## Assessment in the review step

For a review task imported from a GitHub PR (a review request or a label), the criteria and the answer shape are added to the review prompt (`reviewRiskLines`).

- The agent is told to give the assessment separately from the findings and the verdict, and not to let the assessment change the weight of a finding, the verdict, or what the review looks at.
- The assessment JSON is removed from the posted body even when its shape is wrong (`extractReviewComments`). One that cannot be parsed as JSON (a trailing comma, and so on) is also removed, together with the code block whose content starts in the shape of the assessment answer (`withoutRiskBlocks`). A code example that merely contains the assessment heading stays. An unparseable assessment that is not in a code block stays, because its extent cannot be determined.
- The body of a review that was not asked to assess (a PR review child task) is not touched.
- If the answer could be read, the assessment is recorded in `PullRequestRiskAssessed` together with the completion of the step's run; if not, the fact that it could not be assessed (with the same reasons as the assessment before opening a PR) is recorded. The cost is counted on the step's run, so this record carries no cost.
- Even when the assessment fails, posting the review is not stopped.

Code: `apps/daemon/src/risk-assessment.ts` (`reviewRiskLines`, `withoutRiskBlocks`), `apps/daemon/src/prompts.ts` (`extractReviewComments`), `apps/daemon/src/service.ts` (`assessesRiskInReview`)

## How it is shown

The PR description and the review comment carry a section of the same shape, "リスク評価" (`riskAssessmentLines`).

- It lists, in order: the level (low, medium, or high), the suggested review depth, the risk signals that apply (if any; each name carries its weight as "（重い）" (heavy) or "（軽い）" (light)), the size of the dependency version update (if any), the kind of change, the reach of the impact, the ease of undoing, what was verified, the places to look at (if any), and a note that it is an AI-made guide.
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

- `PullRequestRiskAssessed` holds the occasion (`via`), the commit assessed (`commit`), and the assessment (`assessment`) or the reason it could not be assessed (`reason`). A record with `via` of `publish` also holds the start of the PR diff at the time of the assessment (`base`). A record that carried over the previous assessment also holds the commit it was originally assessed at (`inheritedFrom`), and has no agent and no cost.
- A task holds only the last assessment (`Task.riskAssessment`). A record of a failed assessment does not keep the earlier assessment.
- The UI shows a "PR risk assessment" section in the overview of the task detail (only for a task with an assessment record). Each signal name carries its weight, and the size of the dependency version update is shown when there is one. The activity shows the occasion and the level (or the reason, if it could not be assessed) in one line. A carried-over assessment is shown in one line saying which commit's assessment was carried over to which commit.

Code: `packages/core/src/projection.ts` (`applyEvent`), `apps/web/src/components/risk-assessment.tsx` (`RiskAssessmentCard`)
