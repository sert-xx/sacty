[日本語](risk-assessment.md) | **English**

# PR risk assessment

sacty has an AI assess the risk of a PR's content, and puts the level, the grounds, the suggested review depth, and the places to look at into the PR review comment and the UI.
The assessment is a guide for a person deciding how deeply to review the PR, and it is given only when a person makes the final judgment (when the review has no findings, including the assessment-only run before the draft is removed when the remaining suggestions of a re-judged round were all declined).
It is not made when a PR is opened or updated, and it is not put in the PR description.
sacty does not skip a review, merge automatically, or change the steps because of the assessment.

Related ADR: [Produce a PR risk assessment (not used to skip reviews or to merge automatically)](../adr/20261116-1632-superseded-pr-risk-assessment.md), [Decide the PR risk level by the weight of the signals and the size of a dependency version update](../adr/20261117-0433-superseded-risk-level-by-signal-weight.md), [When the size of a dependency version update cannot be read, make the PR risk level medium](../adr/20261117-0455-unknown-dependency-update-is-medium.md), [The PR risk assessment reads only the last answer and does not fall back to an earlier one when it cannot be read](../adr/20261117-1245-risk-assessment-reads-only-last-answer.md), [Assess the PR risk only in a round where the review has no findings](../adr/20261121-0300-superseded-risk-assessment-only-when-review-has-no-findings.md), [Separate risk grounds and human requests into independent Alerts](../adr/20261121-0345-risk-assessment-alerts.md)

## When it is assessed

It is assessed in only two occasions.
- A round of the PR review step where the head of this round was judged to have no findings (`via` is `review`). The review step's agent assesses it, giving the assessment with its review answer.
- The assessment-only run before the draft is removed, when a re-judged round leaves only suggestions and all of them are declined (`via` is `suggestions_declined`; PBI-440). There is no re-review. An orchestrator agent reads the code and the diff after the implementation, with the remaining suggestions and the reasons they were declined as material. The result goes into one PR comment and the UI. Even if it cannot be assessed, the reason is recorded and the draft is removed. It is not repeated for the same head of the same PR. Its cost is recorded like any assessment run and counts toward the budget. The target is the task that opened the implementation PR, on a daemon with the risk assessment enabled.

| Review step | Assessed? |
| --- | --- |
| A review child task that sacty created for its own **implementation PR** (`reviewOf.step` is `implement`) | Yes |
| A review task imported from a GitHub PR (a review request or a label) | Yes |
| A child task of a requirements or design PR | No |
| A child task of a task that took over an existing PR | No |

- Nothing is assessed when sacty opens or updates a PR (no agent is run for it, and no wait is added).
- The range of PRs that a child task assesses is the same as the range that was assessed before a PR was opened or updated (a requirements or design PR and a taken-over existing PR are not assessed).
- Only a daemon that enabled the risk assessment (`riskAssessment` of `ServiceDeps`, enabled when the daemon starts) assesses in a child task of an implementation PR. A review imported from a PR does not depend on this setting, as before.
- "No findings" means a round where sacty read the verdict of that round as no findings (`no_findings`). Even if the verdict block says no findings, a round turned into suggestions because of a line comment, a round that requires fixes, and a round with no verdict are not rounds with no findings.

Code: `apps/daemon/src/risk-assessment.ts` (`assessesRiskInReview`), `apps/daemon/src/service.ts` (`assessesReviewRisk`)

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
- No score or probability is produced. The numbers 1–3 in posted comments identify the low, medium, and high categories.

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
{"sacty-risk-assessment": {"level": "medium", "signals": [], "dependencyUpdate": "none", "change": "変更の種類", "scope": "影響の範囲", "reversibility": "取り消しやすさ", "verification": "確かめた範囲", "focus": [{"where": "src/pay.ts:40-72", "why": "見る理由と、人間に判断・確認してほしいこと"}]}}
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
| `focus` | The places a person should look at (`where` is a path and lines, `why` includes both the reason to look and what the person should judge or verify; up to 5. Do not repeat the full finding) |

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

## When a PR is opened or updated

sacty does not assess the risk when it opens or updates an implementation PR (PBI-429).
No wait for an assessment is added between pushing the commit and opening or updating the PR.

- A `PullRequestRiskAssessed` with `via` of `publish` is no longer recorded. A record that carries over a previous assessment (`inheritedFrom`) is not made either.
- No pause is caused by an assessment run that could not be confirmed to have stopped.
- The PR description does not carry the assessment (neither in sacty's fixed format nor in the format that follows the template). A task with a record from before the version upgrade with `via` of `publish` does not get the old assessment in the body when it updates the PR either.
- The body of a PR with no submission is not rewritten (the bodies of PRs opened in the past are not corrected retroactively).
- The judgment of whether the span from the previous head to the current head is documents only (`documentsOnlySince`) remains, for narrowing a re-review ([Tasks and steps](tasks-and-steps.en.md)).

Code: `apps/daemon/src/service.ts` (`publish`, `documentsOnlySince`)

## Assessment in the review step

The criteria and the answer shape are added to the prompt of a review that is assessed ([When it is assessed](#when-it-is-assessed)) (`reviewRiskLines`).

- The prompt tells the agent to give the assessment only when it judges no findings. When the verdict is changes required or suggestions, or no verdict is given, it does not give one (it does not read the code in depth for the assessment). The assessment goes in the same answer, before the verdict JSON.
- The agent is told to give the assessment separately from the findings and the verdict, and not to let it change the weight of a finding, the verdict, the reviewers started, what the review looks at, whether the draft is lifted, the merge, or the steps.
- After deciding the verdict, sacty uses the assessment only in a round with no findings (`extractReviewComments`). In a round that is not a no-findings round (findings, or no verdict), the assessment is not recorded and not put in the posted comment (not even "could not be assessed").
- In a review that is assessed, the assessment JSON is removed from the posted body even when it is in the answer of a round that is not a no-findings round or its shape is wrong. One that cannot be parsed as JSON (a trailing comma, and so on) is also removed, together with the code block whose content starts in the shape of an assessment answer (`withoutRiskBlocks`). A code example that merely contains the assessment heading string is kept. An assessment that is not in a code block and cannot be parsed as JSON remains, because its range cannot be decided.
- The body of a review that is not assessed (a child task of a requirements or design PR, of a continued PR, or of a daemon with risk assessment disabled) is not touched.
- In a round with no findings, if the answer could be read, the assessment is recorded in `PullRequestRiskAssessed` together with the completion of the step's run; if not, the fact that it could not be assessed (the reason is `pr.riskUnreadable`, `pr.riskLastUnreadable`, or `pr.riskKeyOutsideAnswer`; see [Content of the assessment and how it is read](#content-of-the-assessment-and-how-it-is-read)) is recorded. No extra run is made for the assessment. The cost is counted in the step's run, so this record holds no cost.
- Even when the assessment fails, posting the review, lifting the draft, and waiting for approval are not stopped.

Code: `apps/daemon/src/risk-assessment.ts` (`reviewRiskLines`, `withoutRiskBlocks`), `apps/daemon/src/prompts.ts` (`extractReviewComments`), `apps/daemon/src/service.ts` (`assessesReviewRisk`)

## How it is shown

The review comment carries the section "リスク評価" (`riskAssessmentLines`). The PR description does not.

- The common renderer separates the decision material, human requests, and verification:
  - The level and grounds appear in a GitHub Alert: low uses `[!NOTE]` and **変更リスク: 低(1)**, medium uses `[!IMPORTANT]` and **変更リスク: 中(2)**, and high uses `[!WARNING]` and **変更リスク: 高(3)**. The kind of change, reach of impact, and ease of undoing form one paragraph for low and separate items for medium/high. The suggested review depth, applicable risk signals (with their weights), and dependency update size remain in this alert.
  - When focus items exist, a separate `[!TIP]` headed **とくに見る箇所（人間への確認依頼）** lists the location and the recorded reason/request in order. No request is invented for older records.
  - **確認範囲・未確認事項** and the AI guidance note are outside the alerts. The existing `verification` remains free text; it is not automatically split into verified and unverified parts.
- Each alert is a top-level blockquote, separated by an unquoted blank line. Every line inside an alert, including blank lines and multiline text in old records, is prefixed with a quote marker.
- A `focus[].where` that is a relative path followed by positive line numbers (for example `src/cancel.ts:10-40`) links to the target repository at `riskAssessment.commit`. The repository host, including Enterprise, is preserved. Path segments are URL encoded, including spaces, Japanese characters, parentheses, brackets, and hash signs. No extra API is called to check file existence. Absolute paths, parent references, invalid/reversed line numbers, invalid Unicode, unknown repositories/commits, and free text remain text.
- When the assessment failed, it says so with the reason, and says to decide the review depth from the diff.
- Only the assessment of the head commit reviewed in this round, in a round with no findings (and the `suggestions_declined` assessment-only run for that head), is shown. An assessment of an earlier round or an earlier head, and one left over in a round without findings, are not shown as this round's. A round that judged the same head again (with no findings) shows that round's assessment.
- The heading, the field names, and the depth text are in Japanese, like sacty's other fixed text. The grounds are shown in the language the agent wrote them in.
- It is placed after the verdict line and before the agent's body. The review body fits within 60,000 UTF-16 code units. The renderer reserves space for the assessment and footer before shortening the agent’s text. If the assessment details alone do not fit, the section directs the reader to the task screen.

Code: `apps/daemon/src/risk-assessment.ts` (`riskAssessmentLines`), `apps/daemon/src/prompts.ts` (`buildReviewBody`)

## Record and UI

- `PullRequestRiskAssessed` holds the occasion (`via`), the commit assessed (`commit`), and the assessment (`assessment`) or the reason it could not be assessed (`reason`). Only records with `via` of `review` (a round with no findings) and `suggestions_declined` (the assessment-only run when the remaining suggestions were all declined) are newly recorded.
- Records from before the version upgrade can still be read. A record with `via` of `publish` (including those with `base`, the start of the PR diff at the time of the assessment, and `inheritedFrom`, the commit carried over from), and a record with `via` of `review` that was made in a round with findings, are loaded as they are. The task detail, the activity row, and the cost totals do not change (a record with no `agentId` gets no cost row).
- A task holds only the last assessment (`Task.riskAssessment`). A record of a failed assessment does not keep the earlier assessment.
- The UI shows a "PR risk assessment" section.
  - The detail of a review task (a child task or an imported PR review) shows that task's own assessment.
  - The detail of the task that opened the PR (including a task waiting for approval) shows the assessment given by the review child task of that implementation PR, without opening the child task. An assessment of a child task comes before an old `publish` assessment from before the version upgrade.
  - It shows which head (commit) was assessed. The "current head" is the head the review child task last reviewed (or is reviewing): `reviewTarget.headCommit`, or `reviewRestartCommit` before the target is resolved. When the assessed head differs, it says it is not for the current head (an assessment is recorded only in a round with no findings or as a `suggestions_declined` run, so after the head advances into a round with findings, the earlier head's assessment remains). With no head to compare, it is not shown as the current head. The detail of the review task itself uses the same comparison. The `suggestions_declined` assessment of the task that opened the PR is shown before the child task's assessment of an earlier head when its assessed commit is that head. A pre-upgrade `publish` assessment is compared with the PR's submitted head and the head judged to have no findings.
  - When there is no assessment yet (no round with no findings and no `suggestions_declined` run yet), nothing is shown.
- The activity shows the occasion and the level (the reason, if it could not be assessed) in one row. A record of a carried-over assessment (from before the version upgrade) shows which commit's assessment was carried over to which commit in one row.

Code: `packages/core/src/projection.ts` (`applyEvent`), `apps/web/src/components/risk-assessment.tsx` (`RiskAssessmentCard`, `riskAssessmentToShow`)
