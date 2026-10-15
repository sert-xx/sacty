[日本語](split-and-integrate.md) | **English**

# Task split and integration review

With the `split` plan, an agent creates child tasks based on the approved design. When all child tasks are settled, Integration review checks whether the child tasks'
results meet the parent's requirements. If it does not pass, fix child tasks are added.

Related ADRs: none

## Splitting

- The number of child tasks is from `MIN_SPLIT_CHILDREN` (2) to `MAX_SPLIT_CHILDREN` (10). From the second round, which adds fix child tasks, a single one can be created.
- The agent's answer (heading `sacty-split`) is checked for the count, duplicate `key` values, missing dependencies, self-dependencies, and dependency cycles. If it cannot be read, the task is paused.
- Child tasks are created with `start: split` and `parent` (the parent's ID and `dependsOn`). The body includes the parent's approved requirements and design.
  Child tasks without dependencies start waiting to run; child tasks with dependencies start as `blocked` and become waiting to run once all their dependencies are settled (`TaskUnblocked`).
- A child task's repository is the child task's `repo`, or the parent's repository if absent. When splitting a parent without a repository, each child task's `repo` is checked against the project's
  targets; if it is missing or not in the targets, the split is not used and the task stops (the agent is instructed to complete each child task within one repository, and to split changes across repositories and connect them with `dependsOn`).
- Splitting is one level only (child tasks cannot choose `split`).
- The parent waits for child tasks in `waiting_children`. When all child tasks are settled (completed, or canceled with a person's acknowledgment), it moves to the next step with `SplitCompleted`.
- When a child task is canceled, the parent is paused (`child_cancelled`). Resuming the parent counts as acknowledging that cancellation.

Code: `apps/daemon/src/service.ts` (`settleSplit`, `childSettled`, `splitWithRepositories`), `apps/daemon/src/prompts.ts` (`extractSplitPlan`, `buildChildBody`, `splitRepositoryLines`), `packages/core/src/events.ts` (`MIN_SPLIT_CHILDREN`, `MAX_SPLIT_CHILDREN`)

## Integration review

- The AI is `step_agents.integrate`, or `guardian_agent` if absent (or `default_agent` if that is absent too).
- The latest base branch is fetched and passed as a disposable copy. For a parent without a repository, copies are laid out per child task repository and base branch.
  The instructions include the approved requirements and design, the test viewpoints (`REQ` if none), a summary of the child tasks (title, status, PR URL, round, repository), and the person's past
  comments.
- The answer (heading `sacty-integration-review`) passes only when every viewpoint is met, no comment has recurred, and `findings` is empty.
- If it passes, the task waits for a person's approval. If it fails, it goes back to `split` to add fix child tasks. If it fails `MAX_INTEGRATION_ATTEMPTS` (3) times
  in a row, it waits for a person's approval while still failing, without adding fix child tasks. Requesting changes while Integration review is waiting for approval resets the count.

Code: `apps/daemon/src/service.ts` (`integrate`, `childRepositories`), `apps/daemon/src/prompts.ts` (`buildIntegrationReviewPrompt`, `extractIntegrationReview`, `integrationViewpointIds`), `apps/daemon/src/config.ts` (`agentFor`), `packages/core/src/events.ts` (`MAX_INTEGRATION_ATTEMPTS`)
