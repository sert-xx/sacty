import type { Locale } from "./locale";
import { common } from "./messages/common";
import { forms } from "./messages/forms";
import { labels } from "./messages/labels";
import { parts } from "./messages/parts";
import { projects } from "./messages/projects";
import { review } from "./messages/review";
import { settings } from "./messages/settings";
import { shell } from "./messages/shell";
import { task } from "./messages/task";
import { tasks } from "./messages/tasks";

/** 画面の言語の文言。領域ごとのファイル（messages/*）をまとめる。 */
export function messagesFor(locale: Locale) {
  return {
    locale,
    labels: labels[locale],
    common: common[locale],
    shell: shell[locale],
    tasks: tasks[locale],
    task: task[locale],
    parts: parts[locale],
    review: review[locale],
    forms: forms[locale],
    projects: projects[locale],
    settings: settings[locale],
  };
}

export type Messages = ReturnType<typeof messagesFor>;
