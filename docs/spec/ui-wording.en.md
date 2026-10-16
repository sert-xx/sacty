[日本語](ui-wording.md) | **English**

# Screen wording and hints

Screen wording is kept as body text (always visible) and hints (tooltips shown when the pointer is over a mark). The body says only
what is happening now and what to do next; how things work, reasons, numbers such as intervals and limits, settings file locations and
definitions of terms go into hints. The wording is kept in Japanese and English dictionaries, and a test checks that the dictionary
strings follow the rules.

Related ADR: [Split screen wording into body and hints, and show explanations of the mechanism in tooltips](../adr/20261016-1244-ui-wording-body-and-hints.md)

## Rules for the body

- The body says only what is happening now and what to do next. How things work, reasons, numbers such as intervals and limits, settings
  file locations and definitions of terms go into a hint or are left out.
- One message is one sentence. Headings, labels and statuses are nouns. Buttons are verbs. The guide is 40 characters in Japanese and
  80 in English.
- No parenthesized notes in the body. Parentheses only attach a number or an ID (for example "PR #12", "3rd").
- Explanatory sentences become a status noun or a short imperative.
- Internal roles (Orchestrator, Goal Guardian, step agent) appear only when a person's decision needs them.
- Never say the same thing twice (heading and note, body and hint).
- What stays in the body: warnings about irreversible, paid or publicly visible actions; errors and failures (what happened, what to do
  next); and, where a person decides, what to look at and what to decide. Errors and decision guidance may be up to two sentences.
- Japanese and English follow the same rules. English is written as short English, not as a translation.

## Rules for hints

- What goes into a hint: how it works, reasons, numbers such as intervals and limits, settings keys and locations, definitions of terms,
  defaults.
- What must not go into a hint: information needed to operate, errors, warnings, required inputs. The screen works without the hints.
- Hints are short too. The limit is 150 characters in Japanese and 320 in English.
- An item without a hint shows no mark.

## The hint component

- The mark is a small i icon next to a heading, label or value, in a color less prominent than the body.
- It opens on hover. It opens when the mark receives keyboard focus (Tab). On touch devices it opens on tap. Esc or a click or tap
  outside closes it.
- A hint opened by hovering does not take focus. The hint text is also placed hidden inside the mark (`sr-only`) and linked
  from the mark by `aria-describedby`, so a screen reader reads the mark's name ("Details") and the text without opening it.
- A long hint is limited to 20rem or the free space on the side of the mark where it is placed (the Positioner's
  `--available-height`) and scrolls inside. With the keyboard, the arrow keys and
  PageUp/PageDown scroll it while the mark keeps focus (the hint is in a portal, so Tab does not move into it). It closes when focus
  leaves the mark.
- A long activity line (the list of available external platforms in the context preparation) shows only its first line, and
  "Details" opens the rest.
- Card headings take a short fact (a count or a status) as `note` and the explanation of the mechanism as `hint`.
- Hints that used to be `title` attributes (such as the cost "Estimate") were replaced by this component.

Code: `apps/web/src/components/ui/hint.tsx` (`Hint`, `WithHint`), `apps/web/src/components/card-section.tsx` (`CardSection`), `apps/web/src/lib/labels.ts` (`describeEventParts`)

## Dictionaries and checks

- The wording lives in per-area dictionaries, and the type of the Japanese dictionary is applied to English (a message missing in one
  language is a type error).
- Hint keys are `hint` and `*Hint`. Decision guidance keys are `*Help` (guidance of up to two sentences that stays in the body and is checked as body text).
- A test checks the string leaves of the dictionaries in both languages: the body contains no line break, is within 60 characters in
  Japanese and 130 in English, and contains no parenthesized note of 14 or more characters in Japanese or 30 or more in English. Hints are
  within 150 characters in Japanese and 320 in English. Exceptions are listed with the key path and the reason (parentheses in headings,
  two-sentence guidance and so on). Messages that take arguments (functions) are not checked.
- Messages the daemon creates and the screen shows (reasons for pauses and failures, intake errors and so on) are shown as they are in
  the core dictionary. They are errors and reasons, shared with the CLI and Slack notifications, so the screen rules do not apply to them.

Code: `apps/web/src/i18n/index.ts` (`messagesFor`), `apps/web/src/i18n/wording-policy.test.ts` (`EXCEPTIONS`), `packages/core/src/messages.ts` (`renderMessage`)
