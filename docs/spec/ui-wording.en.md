[日本語](ui-wording.md) | **English**

# Screen wording and hints

Screen wording is kept as body text (always visible) and hints (tooltips shown when the pointer is over a mark). The body says only what is happening now and what to do next. How things work, reasons, numbers such as intervals and limits, settings file locations and definitions of terms go into hints.

The wording is kept in Japanese and English dictionaries, and a test checks that the dictionary strings follow the rules.

Related ADR: [Split screen wording into body and hints, and show explanations of the mechanism in tooltips](../adr/20261016-1244-ui-wording-body-and-hints.md)

## Rules for the body

- Write the product name as Sacty in both Japanese and English, including the header, browser title, sign-in page, activity, and errors. Keep identifiers such as commands, settings keys, cookies, label names, and paths unchanged.
- The body says only what is happening now and what to do next. How things work, reasons, numbers such as intervals and limits, settings file locations and definitions of terms go into a hint or are left out.
- One message is one sentence. Headings, labels and statuses are nouns, and buttons are verbs. The length guide is 40 characters in Japanese and 80 in English.
- No parenthesized notes in the body. Parentheses only attach a number or an ID (for example "PR #12", "3rd").
- Explanatory sentences become a status noun or a short imperative.
- Internal roles (Orchestrator, step agent) appear only when a person's decision needs them.
- Never say the same thing twice (heading and note, body and hint).
- The body keeps the following. Errors and decision guidance may be up to two sentences.
  - Warnings about irreversible, paid or publicly visible actions
  - Errors and failures (what happened, what to do next)
  - Where a person decides, what to look at and what to decide
- Japanese and English follow the same rules. English is written as short English, not as a translation.

## Rules for hints

- What goes into a hint: how it works, reasons, numbers such as intervals and limits, settings keys and locations, definitions of terms, defaults.
- What must not go into a hint: information needed to operate, errors, warnings, required inputs. The screen works without the hints.
- Hints are short too. The limit is 150 characters in Japanese and 320 in English.
- An item without a hint shows no mark.

## The hint component

- The mark is a small i icon next to a heading, label or value, in a color less prominent than the body.
- Opening and closing a hint
  - It opens on hover.
  - It opens when the mark receives keyboard focus (Tab).
  - On touch devices it opens on tap.
  - Esc or a click or tap outside closes it.
- The mark's touch target is at least 24×24px (the visible mark stays 20px, and the height and layout of the surrounding line do not change).
- The mark's name is "Details" by default. A mark next to a heading or label (`WithHint`, and the heading of `CardSection`, when the label is a string) is named so that it says what it explains, such as "Details about Your turn". A mark placed directly, or next to a label that is not a string, stays "Details".
- A hint opened by hovering does not take focus. The hint text is also placed hidden inside the mark (`sr-only`) and linked from the mark by `aria-describedby`. A screen reader therefore reads the mark's name ("Details", or "Details about <label>" when the label is a string) and the text without opening it.
- The name of the dialog × and of the `DialogFooter` close button follows the screen language ("閉じる" / "Close", `common.close` in the dictionary).
- A long hint is limited in height to 20rem or the free space on the side of the mark where it is placed (the Positioner's `--available-height`), and scrolls inside. With the keyboard, the arrow keys and PageUp/PageDown scroll it while the mark keeps focus. The hint is in a portal, so Tab does not move into it. It closes when focus leaves the mark.
- A context preparation activity line (`ContextResolved`) shows only the layers read and the warnings. "Details" opens the definitions of the tier subagents placed (each tier's agent, model, and reasoning effort; `ContextTiers`) and the list of available external platforms (without either, no "Details" is shown).
- A resume activity line with a note (`note` of `TaskResumed`) shows the resume text with ", with notes" added. "Details" opens the note the person added (to read again which resume added it).
- An unfinished-implementation activity line (`ImplementationIncomplete`) shows only the number of remaining items. "Details" opens what the agent declared as remaining (one item per line; no "Details" when nothing remains; the line for viewpoints without a test shows the viewpoint IDs in the line; the line of a record that adds a run asking only for the declaration (`declarationOnly`) says so, with the missing viewpoint IDs when there are any).
- A request-for-changes activity line (`ChangesRequested`) shows only the number of comments. "Details" opens the comments a person wrote (the comment ID and text, one per line). The approval page shows its content only while the task is awaiting approval or escalated, so this is how to read the comments again after approval, completion, or cancellation.
- A steps-chosen activity line (`StepsChosen`) shows only the names of what was chosen (the step order, image, export targets, services, and skipped steps), with the cost-unknown mark at the end. The reasons (why these steps, the image, the export targets, the services, why the repository has no tests, and why the after-merge watch is skipped) get a heading each, one per line, in "Details" (no "Details" for an old record without reasons).
- A repository-chosen activity line (`RepositoryChosen`) shows only the repository ("(person)" when a person chose it). "Details" opens why it was chosen (no "Details" when a person chose it or the record has no reason).
- "Recent activity" in the right column cuts every kind of line to 2 lines and shows no "Details". Read the full text in the Activity tab, from "Show all (n)", which appears when there are more than 5 entries (or open the Activity tab directly). "This run's activity" on the run log page has the same form as the Activity tab, with "Details".
- Card headings take a short fact (a count or a status) as `note` and the explanation of the mechanism as `hint`.
- Hints that used to be `title` attributes (such as the cost "Estimate") were replaced by this component.

Code: `apps/web/src/components/ui/hint.tsx` (`Hint`, `WithHint`), `apps/web/src/components/card-section.tsx` (`CardSection`), `apps/web/src/lib/labels.ts` (`describeEventParts`), `apps/web/src/components/task-detail.tsx` (`EventText`)

## Dictionaries and checks

- The wording lives in per-area dictionaries, and the type of the Japanese dictionary is applied to English. A message missing in one language is a type error.
- Hint keys are `hint` and `*Hint`. Decision guidance keys are `*Help` (guidance of up to two sentences that stays in the body), checked as body text.
- A test checks the string leaves of the dictionaries in both languages. Messages that take arguments (functions) are not checked.
  - The body contains no line break, is within 60 characters in Japanese and 130 in English, and contains no parenthesized note of 14 or more characters in Japanese or 30 or more in English.
  - Hints are within 150 characters in Japanese and 320 in English.
  - Exceptions are listed with the key path and the reason (parentheses in headings, two-sentence guidance and so on).
- Messages the daemon creates and the screen shows (reasons for pauses and failures, intake errors and so on) are shown as they are in the core dictionary. They are errors and reasons, shared with the CLI and Slack notifications, so the screen rules do not apply to them.

Code: `apps/web/src/i18n/index.ts` (`messagesFor`), `apps/web/src/i18n/wording-policy.test.ts` (`EXCEPTIONS`), `packages/core/src/messages.ts` (`renderMessage`)
