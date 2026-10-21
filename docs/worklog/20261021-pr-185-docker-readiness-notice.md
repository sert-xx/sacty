# 起動中に Docker を使える状態かを確かめ、使えなければどの画面でも警告を出す

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: #185
- ブランチ: claude/epic-goodall-qizmqt
- 関係する ADR: なし

## 目的

Sacty の起動中に、Docker を使える状態か（Docker デーモンが動いているか、各イメージの、動いている版に対応するタグのイメージが手元にあるか）を
確かめ、異常なら画面に警告を出す。PBI-148 で、イメージが手元にあるかの確かめと、タスクの一覧の注意の欄への表示はあった。足りなかったのは次の3点。

- Docker デーモンが動いているかを、イメージとは別に確かめていなかった（設定に誤りがあってイメージを確かめないときは、Docker が止まっていても何も出なかった。
  docker のコマンドが無いことと、デーモンに接続できないことも区別していなかった）。
- `sacty config init` が書いた `image: sacty-agent:<版>` は、Sacty の版を上げても `config.yaml` に残る。確かめるのはその古い名前のイメージなので、手元に
  あれば注意が出ず、動いている版に対応するイメージを使っていないことに気づけなかった。
- 注意はプロジェクトのタスクの一覧の画面にしか出なかった。

## したこと

- デーモン（`apps/daemon/src/image-presence.ts`）
  - docker の起動・打ち切り・時間切れを `runDocker` にまとめ、`pingDocker`（`docker version --format {{.Server.Version}}`）を足した。`running`・`noCli`（起動の
    `ENOENT`）・`unreachable` を返す。`inspectImage` は `runDocker` を使うように直した（振る舞いは同じ）。
  - `ImagePresenceChecker` は、先に `ping` で Docker を確かめ、動いていなければイメージを確かめずに `image.dockerNotInstalled` か `image.dockerUnreachable` を
    1つだけ出す。
  - `ImageTarget` に、動いている版のイメージの名前（`expected`。既定は `DEFAULT_IMAGE`、言語ごとは `languageImageTag(名前)`）を足した。`isOutdatedImage` で、
    同じリポジトリ（`sacty-agent`・`sacty-agent-<名前>`）でタグだけが違えば `image.outdated`（直す場所・動いている版の名前・作るコマンド）を出し、そのイメージは
    確かめない。利用者が付けた名前・レジストリのイメージは比べない。
- 状態（`apps/daemon/src/service.ts`）：Docker とイメージの注意を `warnings` から外し、`GET /api/status` の `docker` に分けた（画面がどの画面でも出すため）。
- 文言（`packages/core/src/messages.ts`）：`image.dockerNotInstalled`・`image.outdated` を日英で足し、`image.dockerUnreachable` を「タスクを実行できない」ことが
  わかる文に直した。
- 画面（`apps/web`）：更新の知らせ（PBI-135）と同じ作りで、`DockerNotice`・`DockerNoticeLive`・`DockerNoticeView` と `/live/docker` を足し、レイアウトの
  中身の上（更新の知らせの上）に出す。30 秒ごとに取り直し、直ればリロードせずに消える。`role="alert"`。
- テスト：`image-presence.test.ts`（`pingDocker` の動いている・接続できない・docker が無い・起動できない・時間切れの境界、Docker が動いていないときはイメージを
  確かめない・動き出したらイメージの注意に変わる、版の違いの見分けと注意・確かめない、英語の文言）、`daemon.test.ts`（`docker` に載せ、`warnings` には
  載せない）、`docker-notice.test.ts`・`docker-notice-live.test.ts`（描画・英語・描いたときのデータ・古いデーモン・取り直しで現れる／消える・間隔の境界・
  届かないとき）。
- 仕様書（`daemon-lifecycle`）とユーザードキュメント（`getting-started`・`troubleshooting`）の日英を直した。方針の大きな変更ではないので ADR は足していない。

## 確かめたこと

- `npm run lint`：通過。`npm run typecheck`：通過。
- `npx vitest run`：125 ファイル中 122 ファイルが通過、8 件が失敗。失敗は `agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts` で、
  変更を戻した状態でも同じ 8 件が失敗する（この作業の環境が root で動いていて、読めないファイル・プロセスの後始末のテストが前提と合わないため）。
- `npx vitest run tests/docs`：通過。
- この作業の環境の docker のコマンド（デーモンは動いていない）で、`docker version --format {{.Server.Version}}` が
  `failed to connect to the docker API at unix:///var/run/docker.sock …`（終了コード 1）になることを確かめた。一時的なテストで、実装した `pingDocker` が
  `unreachable`、`inspectImage("sacty-agent:1.7.1")` が `unreachable`、PATH に docker が無いときの `pingDocker` が `noCli` になることを確かめた（一時的なテストは消した）。
- Docker が動いている環境での確かめと、実際の `sacty up` を起動して画面に出ることは確かめていない。運用の環境で、Docker を止めて起動すると画面の上に
  「Docker に接続できません」が出て、Docker を起動すると 1 分ほどで消えること、`config.yaml` の `image` を前の版にすると `image.outdated` が出ることを確かめる。

## 残したこと

- `config.yaml` の古い `image` を自動では書き換えない（利用者の設定のため、直し方を示すだけにした）。

## レビューの指摘と対応（PR #185）

| 指摘 | 対応 |
| --- | --- |
| 【提案】言語ごとのイメージでは、`image.outdated` が `images.java.image: sacty-agent-java:<版>` を直す内容として出す。そのまま config.yaml に写すと、ドットを含む1つのキーになり、`images` → `java` → `image` は直らない（英語の版も） | YAML の書き方を示すのをやめ、「config.yaml の `images.java.image` の値を `sacty-agent-java:<版>` に直す」と、直す場所と値を分けて案内するようにした（日英）。テストの期待する文言も直した |
