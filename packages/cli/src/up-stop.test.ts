import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORCE_STOP_TIMEOUT_MS,
  FORCE_STOPPING_MESSAGE,
  STOP_TIMEOUT_MS,
  STOPPING_MESSAGE,
  UpStopper,
} from "./up-stop.js";

/** 受けたシグナルを記録し、respond なら受けたらすぐ終わる子プロセス。 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];

  constructor(private readonly respond: (signal: string) => boolean = () => false) {
    super();
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(String(signal));
    if (this.respond(String(signal))) this.end();
    return true;
  }

  end(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

const setup = (daemon: FakeChild, web: FakeChild) => {
  const exit = vi.fn<(code: number) => void>();
  const log = vi.fn<(line: string) => void>();
  const stopper = new UpStopper({ exit, log });
  // 実際の ChildProcess の代わり（使うのは exitCode・signalCode・kill・once だけ）
  stopper.add("daemon", daemon as never);
  stopper.add("web", web as never);
  return { stopper, exit, log };
};

describe("sacty up を止める", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("1回目のシグナルで、止めていることを表示し、子に SIGTERM を送り、すべて終わったら終わる", () => {
    const daemon = new FakeChild();
    const web = new FakeChild((s) => s === "SIGTERM");
    const { stopper, exit, log } = setup(daemon, web);

    stopper.signal();
    expect(log).toHaveBeenCalledWith(STOPPING_MESSAGE);
    expect(daemon.signals).toEqual(["SIGTERM"]);
    expect(web.signals).toEqual(["SIGTERM"]);
    expect(exit).not.toHaveBeenCalled();

    daemon.end();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("2回目のシグナルで、デーモンに FORCE_STOP_SIGNAL（SIGUSR2）、画面に SIGKILL を送る", () => {
    const daemon = new FakeChild();
    const web = new FakeChild();
    const { stopper, log } = setup(daemon, web);

    stopper.signal();
    stopper.signal();
    expect(log).toHaveBeenLastCalledWith(FORCE_STOPPING_MESSAGE);
    expect(daemon.signals).toEqual(["SIGTERM", "SIGUSR2"]);
    expect(web.signals).toEqual(["SIGTERM", "SIGKILL"]);

    // 3回目以降は何もしない
    stopper.signal();
    expect(daemon.signals).toEqual(["SIGTERM", "SIGUSR2"]);
  });

  it("待たずに止めても残る子には、5秒後に SIGKILL を送って終わる（30秒の保険は取り消す）", () => {
    const daemon = new FakeChild();
    const web = new FakeChild((s) => s === "SIGKILL");
    const { stopper, exit } = setup(daemon, web);

    stopper.signal();
    vi.advanceTimersByTime(1_000);
    stopper.signal();
    vi.advanceTimersByTime(FORCE_STOP_TIMEOUT_MS - 1);
    expect(daemon.signals).toEqual(["SIGTERM", "SIGUSR2"]);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(daemon.signals).toEqual(["SIGTERM", "SIGUSR2", "SIGKILL"]);
    expect(exit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(STOP_TIMEOUT_MS);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("2回目のシグナルが無ければ、30秒後に残る子に SIGKILL を送って終わる", () => {
    const daemon = new FakeChild();
    const web = new FakeChild((s) => s === "SIGTERM");
    const { stopper, exit } = setup(daemon, web);

    stopper.signal();
    vi.advanceTimersByTime(STOP_TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(daemon.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(web.signals).toEqual(["SIGTERM"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("子が想定外に終わって止めているときの終了コードを、待たずに止めても保つ", () => {
    const daemon = new FakeChild();
    const web = new FakeChild();
    const { stopper, exit, log } = setup(daemon, web);

    stopper.stop(1);
    expect(log).not.toHaveBeenCalled();
    stopper.signal();
    vi.advanceTimersByTime(FORCE_STOP_TIMEOUT_MS);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
