/**
 * 利用上限で失敗した文から、上限が明ける時刻を読み取る（PBI-428）。確かめた形だけを読み、時間帯を推測しない。
 *
 * 読む形：
 * - Claude Code：`… session|weekly|Opus|Sonnet|spend limit · resets [Mon ]3:45pm (Asia/Tokyo)`（時間帯の名前つき）
 * - Claude Code の古い形：`Claude AI usage limit reached|1760000000`（エポックからの秒）
 *
 * 読まない形（時間帯を確かに知る手段が無い）：日付つきの `resets Dec 1`、時間帯の名前の無い Claude Code の `resets 3:45pm`、Codex の `try again at …`。
 * 読めないときは undefined（呼ぶ側は、今までどおり cooldown_minutes を使う）。
 */

/** 読む文の長さの上限（外から来た文なので、これより後ろは読まない）。 */
const MESSAGE_MAX = 2000;
/** 失敗の時刻のすぐ前（時計のずれ）と見なす幅。この中の時刻は、翌日・翌週とは読まず、読み取れない扱いにする。 */
const LIMIT_RESET_PAST_GRACE_MS = 30 * 60_000;
/** 失敗の時刻から、これより先の時刻は読まない（週の上限が収まる長さ）。 */
export const LIMIT_RESET_MAX_AHEAD_MS = 8 * 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 量指定は、すべて上限つきで、入れ子にしない（処理時間が文の長さに比例する形だけ）
const CLAUDE_RESET =
  /(?:session|weekly|Opus|Sonnet|spend) limit(?: reached)? · resets (?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([A-Za-z0-9_+/-]{1,40})\)/;
const EPOCH_RESET = /Claude AI usage limit reached\|(\d{10})(?!\d)/;

function formatterFor(zone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return undefined;
  }
}

interface ZoneParts {
  /** その時間帯の壁時計を、UTC として表したミリ秒。 */
  wallMs: number;
}

function zoneParts(fmt: Intl.DateTimeFormat, ms: number): ZoneParts {
  const get: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) get[p.type] = p.value;
  const wallMs = Date.UTC(
    Number(get.year),
    Number(get.month) - 1,
    Number(get.day),
    Number(get.hour),
    Number(get.minute),
    Number(get.second),
  );
  return { wallMs };
}

/** 時間帯の壁時計（UTC として表したミリ秒）を、エポックからのミリ秒にする。 */
function wallToEpoch(fmt: Intl.DateTimeFormat, wallMs: number): number {
  let guess = wallMs;
  for (let i = 0; i < 3; i++) {
    const offset = zoneParts(fmt, guess).wallMs - guess;
    guess = wallMs - offset;
  }
  return guess;
}

function readClaudeReset(text: string, nowMs: number): number | undefined {
  const m = CLAUDE_RESET.exec(text);
  if (!m) return undefined;
  const [, day, hourText, minuteText, meridiem, zone] = m;
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const fmt = zone ? formatterFor(zone) : undefined;
  if (!fmt) return undefined;
  const hour = (hour12 % 12) + (meridiem === "pm" ? 12 : 0);
  const today = zoneParts(fmt, nowMs).wallMs;
  const dayStart = today - (today % DAY_MS);
  const weekday = day === undefined ? undefined : WEEKDAYS.indexOf(day);
  // 昨日から 8 日後まで、いちばん近い（失敗の時刻のすぐ前を含む）候補を探す
  for (let k = -1; k <= 8; k++) {
    const wall = dayStart + k * DAY_MS + (hour * 60 + minute) * 60_000;
    if (weekday !== undefined && new Date(wall).getUTCDay() !== weekday) continue;
    const at = wallToEpoch(fmt, wall);
    if (at <= nowMs - LIMIT_RESET_PAST_GRACE_MS) continue;
    // すぐ前の時刻は、翌日・翌週とは読まない
    if (at <= nowMs) return undefined;
    return at - nowMs <= LIMIT_RESET_MAX_AHEAD_MS ? at : undefined;
  }
  return undefined;
}

function readEpochReset(text: string, nowMs: number): number | undefined {
  const m = EPOCH_RESET.exec(text);
  if (!m) return undefined;
  const at = Number(m[1]) * 1000;
  return at > nowMs && at - nowMs <= LIMIT_RESET_MAX_AHEAD_MS ? at : undefined;
}

/** 失敗の文から、上限が明ける時刻（エポックからのミリ秒）を読む。読み取れなければ undefined。 */
export function parseLimitReset(message: string, nowMs: number): number | undefined {
  const text = message.slice(0, MESSAGE_MAX);
  return readClaudeReset(text, nowMs) ?? readEpochReset(text, nowMs);
}
