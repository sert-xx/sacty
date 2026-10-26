import { randomUUID } from "node:crypto";
import type { NotificationKind } from "@sacty/core";

/**
 * 画面（ブラウザ）のデスクトップ通知のための、最近の通知の一覧。Slack と同じ通知（承認待ち・エスカレーション・一時停止・
 * 完了）を、番号を付けてメモリーに持つ。画面は、前に受け取った番号より後のものを取り直して、デスクトップ通知を出す。
 * デーモンを起動し直すと一覧は空に戻り、番号も 1 から数え直す（boot が変わるので、画面は数え直したとわかる）。
 */

/** 持っておく件数の上限（古いものから捨てる）。画面は数秒ごとに取り直すので、取りこぼすほど溜まらない。 */
const FEED_MAX = 100;

export type FeedItem = {
  seq: number;
  /** 通知した日時（ISO 8601）。 */
  at: string;
  taskId: string;
  kind: NotificationKind;
};

export type FeedReply = {
  /** デーモンの起動ごとに変わる値。 */
  boot: string;
  /** 最後の番号（まだ無ければ 0）。 */
  latest: number;
  /** after より後の通知（古い順）。 */
  items: FeedItem[];
};

export class NotificationFeed {
  readonly boot = randomUUID();
  private items: FeedItem[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(taskId: string, kind: NotificationKind): void {
    this.seq += 1;
    this.items.push({ seq: this.seq, at: this.now().toISOString(), taskId, kind });
    if (this.items.length > FEED_MAX) this.items.splice(0, this.items.length - FEED_MAX);
  }

  /** after より後の通知。after が無ければ、通知は返さず最後の番号だけを返す（画面を開く前の通知は出さない）。 */
  since(after: number | undefined): FeedReply {
    return {
      boot: this.boot,
      latest: this.seq,
      items: after === undefined ? [] : this.items.filter((item) => item.seq > after),
    };
  }
}
