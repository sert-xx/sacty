[日本語](split-and-integrate.md) | **English**

# Task split and integration review

With the `split` plan, an agent creates child tasks based on the approved design. When all child tasks are settled, Integration review checks whether the child tasks' results meet the parent's requirements. If it does not pass, the agent adds fix child tasks.

Related ADRs: none

## Splitting

- The number of child tasks is from `MIN_SPLIT_CHILDREN` (2) to `MAX_SPLIT_CHILDREN` (10). From the second round, which adds fix child tasks, a single one can be created.
- The agent's answer (heading `sacty-split`) is checked for the count, duplicate `key` values, missing dependencies, self-dependencies, and dependency cycles. If it cannot be read, the task is paused.
- Child tasks are created with `start: split` and `parent` (the parent's ID and `dependsOn`). The body includes the parent's approved requirements and design, and the information the parent gathered at the start of the task (if any). Child tasks do not gather information again ([Tasks and steps](tasks-and-steps.en.md#information-gathering)). Child tasks without dependencies start waiting to run; child tasks with dependencies start as `blocked` and become waiting to run once all their dependencies are settled (`TaskUnblocked`).
- A child task's repository is the child task's `repo`, or the parent's repository if absent. When splitting a parent without a repository, each child task's `repo` is checked against the project's targets; if it is missing or not in the targets, sacty does not use the split and stops the task. The instructions tell the agent to complete each child task within one repository, and to split changes across repositories and connect them with `dependsOn`.
- Splitting is one level only (child tasks cannot choose `split`).
- The parent waits for child tasks in `waiting_children`. When all child tasks are settled (completed, or canceled with a person's acknowledgment), it moves to the next step with `SplitCompleted`.
- When a child task is canceled, the parent is paused (`child_cancelled`). Resuming the parent counts as acknowledging that cancellation.

Code: `apps/daemon/src/service.ts` (`settleSplit`, `childSettled`, `splitWithRepositories`), `apps/daemon/src/prompts.ts` (`extractSplitPlan`, `buildChildBody`, `splitRepositoryLines`), `packages/core/src/events.ts` (`MIN_SPLIT_CHILDREN`, `MAX_SPLIT_CHILDREN`)

## Integration review

- The AI is `step_agents.integrate`, or `guardian_agent` if absent (or `default_agent` if that is absent too).
- The latest base branch is fetched and passed as a disposable copy. For a parent without a repository, copies are laid out per child task repository and base branch. The instructions include the approved requirements and design, the test viewpoints (`REQ` if none), a summary of the child tasks (title, status, PR URL, round, repository), the person's past comments, and the AI review's past comments (in separate sections). The viewpoint IDs in the output format example are the viewpoint IDs under review (`integrationViewpointIds`; PBI-137).
- As in the final review, the instructions keep the check of the acceptance criteria from shrinking to confirming that a name, item, file, or link exists (`ACCEPTANCE_DEPTH_REVIEW_LINE`), have the Goal Guardian check, when the diff newly adds or changes a shared mechanism (a queue, a lock, a cache, a flag, and so on), that later processing continues after an anomaly or failure (`sharedMechanismLines`; there is no field for what a person should check, so what could not be checked is written in the explanation of the verdict), and have it write its output in the language of the task (`OUTPUT_LANGUAGE_LINE`; PBI-301; see the final review in [Tasks and steps](tasks-and-steps.en.md)).
- The answer (heading `sacty-integration-review`) passes only when every viewpoint is met, no comment has recurred, and `findings` is empty.
  The comments are both the person's and the AI review's, and the instructions ask for a recurrence verdict on both (as in the final review; see [Tasks and steps](tasks-and-steps.en.md)). An AI review comment with no verdict fails the review.
- A broken JSON answer is read with repairs, as for the final review (PBI-298: double quotes and control characters inside strings, and so on; the answer has no nested object, so a missing closing bracket is not added). A read with repairs is recorded in `outputRepaired` of `IntegrationReviewed`. If it still cannot be read, the review stays failed, and the summary says where it is broken (the line and column in the JSON; `integrate.unreadableAt`) or that fields are missing (`integrate.unreadableShape`).
- If it passes, the task waits for a person's approval. If it fails, it goes back to `split` to add fix child tasks. If it fails `MAX_INTEGRATION_ATTEMPTS` (3) times in a row, it waits for a person's approval while still failing, without adding fix child tasks. Requesting changes while Integration review is waiting for approval resets the count.

Code: `apps/daemon/src/service.ts` (`integrate`, `childRepositories`), `apps/daemon/src/prompts.ts` (`buildIntegrationReviewPrompt`, `extractIntegrationReview`, `integrationViewpointIds`), `apps/daemon/src/config.ts` (`agentFor`), `packages/core/src/events.ts` (`MAX_INTEGRATION_ATTEMPTS`)
