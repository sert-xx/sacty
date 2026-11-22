<!-- sacty task aa881a4a-28fb-4544-814e-7af648a44e79 の設計。sacty が作成しました。 -->

# 設計：工程の担当に、この環境の docker・サービスの使い方をスキルで渡す（PBI-486）

## スコープ

工程の担当が読むスキル `docker-services` を、sacty が実行ごとに作って置く。
中身はサービスを起動した・しなかったで変える。
工程の指示には、このスキルを先に読むよう 1 行添える。

- 対象
  - スキル `docker-services` の生成と置き方（Claude Code・Codex）。置くのは工程の実行（`StepKey` のすべて。PR のレビューを含む）
  - 工程の指示の 1 行と、スキルと同じデータから作る接続先の候補
  - 既定の review スキルの `verification-run.md` に 1 行
  - 仕様書・ユーザー文書（日英）、ADR、作業履歴
- 対象外
  - PR のレビューの工程でサービスを起動すること（PBI-489）
  - オーケストレーターがサービスを選ぶ判断（PBI-487・PBI-488）
  - 情報収集・オーケストレーター・作業（operation の MCP の実行）・書き出し・デプロイの監視の実行に、スキルを置くこと（Q-2）
  - 接続先に届くことの保証（`network_mode`・待受のアドレス・転送の組み合わせごとに接続先を確保すること。`services.ts` の起動の書き換えと、`network_mode: bridge` を外す変更を含む）。スキルは今の案内の接続先を候補として書き、届かなければ報告させる

## 確認したいこと

- must：なし
- should
  - Q-1：プロジェクトのコンテキストで、このスキルの上書き・`remove` を許すか。
    許さない（段階のサブエージェントの定義と同じく、sacty が作る予約の名前にし、層の同じ名前のスキルは写さずに警告する）。
    懸念：独自の docker の案内を既定のコンテキストの層で置きたい利用者は、置き換えられない（リポジトリのスキルに書くことになる）。
  - Q-2：情報収集とオーケストレーターの実行にも置くか。
    置かない（情報収集は `gatherServiceLines` で docker を使えないことを伝えており、どちらもテストを動かさない）。
    懸念：情報収集の担当が、リポジトリの docker の手順を読んで「DB が無いので調べられない」と書き、まとめが要る情報を落とす場合がある。
  - Q-3：接続先の候補を指示にも短く残す。スキルと同じデータから作り、詳しくは先にスキルを読むよう添える。
- 確認しないと決めたこと
  - 渡す工程：工程の実行の経路（`service.ts` の工程の実行）のすべての `StepKey` に置く。AC1 が「サービスを使える工程に限らず、PR のレビューを含む」と決めている。
  - review スキルとの合わせ方：`verification-run.md` に「DB などのサービスが要る検証は `docker-services` に従い、確かめられなかったことを本文に書く」を足す。AC3 がレビューの本文に書くことを求めている。
  - ADR 20261112-0040（リポジトリのレビューのスキル・指示を基準として読む）との関係：今回の優先は docker・サービスの起動と接続に限り、レビューの基準は変えない。新しい ADR にこの範囲を書く。

## 既定で決めたこと

- スキルの名前は `docker-services`。
- 接続先が届かないとき（ぶつかった番号・使用中で転送できなかった番号・TCP 以外・localhost をソケットとして扱うクライアント）の合わせ方は、その実行の環境変数か、コミットしない設定で変える。リポジトリの設定の既定値はコミットで変えない。
- スキルの本文は、sacty・特定の言語・特定の DB に寄せた例を書かない（AC5 は既定のコンテキストの条件だが、同じく全リポジトリに渡るため）。製品名は description の一覧（MySQL・PostgreSQL・Redis など）だけ。

## 構成

| 所 | 変更 |
| --- | --- |
| `apps/daemon/src/prompts.ts` | `serviceSkill(services)` を足す（SKILL.md の全文を返す）。`servicePromptLines` はすべての工程にスキルを先に読む 1 行を出し、起動時は同じデータから接続先の候補も出す |
| `apps/daemon/src/context.ts` | `planContext` に sacty が作るスキルを受ける引数を足す。層のスキルの後に置き、層の同じ名前のスキルは写さずに `context.reservedSkill` で警告する。Codex の AGENTS.md のスキルの一覧にも出す |
| `apps/daemon/src/service.ts` | 工程の実行の `runContext` で、起動していない中身のスキルを置く。サービスを起動したら、実行の前に、置いたディレクトリの SKILL.md を `serviceSkill(started.services)` で書き直す |
| `packages/core/src/messages.ts` | `context.reservedSkill`（日英）を足す |
| `default-context/skills/review/review-dispatch/references/verification-run.md` | サービスが要る検証の扱いの 1 行 |
| `docs/spec/services.md`・`context.md`（日英） | スキルの中身・置く実行・予約の名前。`servicePromptLines` の記述を直す |
| `docs/user/compose.md`・`context.md`（日英） | 担当にスキルで案内すること。`docker-services` の名前の層のスキルは使わないこと |
| `docs/adr/`・`docs/worklog/` | ADR（`20261122-HHMM-docker-services-skill.md`）と作業履歴（`20261122-pbi-486-docker-services-skill.md`） |

## スキルの中身

- description：docker・docker compose を使うとき、DB（MySQL・PostgreSQL・Redis など）・キャッシュ・モックの API を起動する・つなぐ必要があるときに、リポジトリのスキル・手順より先に読む。
- 共通：この環境では docker・docker compose のコマンドは使えない。サービスの起動・接続は、リポジトリのスキル・手順よりこのスキルに従う。
- 起動した実行
  - サービスごとの接続先の候補。今の `servicePromptLines` が伝えている内容（サービス名:ポート、localhost の転送の予定、転送しなかった番号・TCP 以外の注記）を、行の作り方を変えずに書く。どの候補も届くとは書かない。
  - 起動・停止はこの環境がするので、リポジトリの手順の起動・停止は飛ばす。アプリは docker を使わずにコンテナの中で起動する。実行が終わるとサービスとデータは消える。
  - 接続先の設定の合わせ方：まず設定のまま試す。届かない・つないだ相手が目的のサービスでないときは、このスキルに書いたそのサービスの別の候補を、環境変数かコミットしない設定で渡して試す。
  - 届かないとき：理由（ポートの使用中・待受のアドレス・ネットワークの構成など）を問わず、候補をすべて試しても届かなければ、黙って飛ばさず「確かめられなかった」と、どのサービスのどの接続先に届かず何を確かめられなかったかを、結果（作業の報告・PR・レビューの本文）に書く。
- 起動していない実行：docker は無く、サービスも起動していない。リポジトリの docker の手順は試さない。サービスが要らない確かめは行い、要るものは黙って飛ばさず、「サービスが無いので確かめられなかった」と何を確かめられなかったかを、結果（作業の報告・PR・レビューの本文）に書く。

## 処理の流れ

1. 工程の実行の `runContext` が、起動していない中身の `skills/docker-services/SKILL.md` を置く。
2. `startServices` がサービスを起動したら、同じファイルを起動した中身で書き直す（起動の失敗で止まる実行は書き直さない）。
3. 工程の指示に、起動時の接続先の候補と、起動の有無によらず 1 行を足す：「docker・docker compose・DB などのサービスを起動する・つなぐ必要があるときは、リポジトリのスキル・手順より先に、スキル `docker-services` を読んで従ってください」。

## テスト観点

- [TV-1] サービスを起動しない工程の実行に、起動していない中身のスキルが置かれること
  - 入力：PR のレビュー（review）の工程を、サービスを起動せずに Claude Code で実行する
  - 期待結果：設定の場所の skills/docker-services/SKILL.md に、docker・docker compose のコマンドが無いこと、サービスが起動していないこと、サービスが要る確かめを飛ばさず「サービスが無いので確かめられなかった」と何を確かめられなかったかを作業の報告・PR・レビューの本文に書くことが書かれている
- [TV-2] サービスを起動した実行で、スキルが実際の接続先の候補で書き直されること
  - 入力：implement の工程で、ポート 5432 と ports "15432:5432" を持つサービス db を起動して実行する
  - 期待結果：実行の時点の skills/docker-services/SKILL.md に、db の接続先の候補として db:5432・localhost:5432・localhost:15432 が書かれ、docker・docker compose のコマンドは使えないこと、リポジトリの手順の起動・停止は飛ばすこと、届かなければ別の候補を環境変数かコミットしない設定で渡して試し、それでも届かなければ何が届かず何を確かめられなかったかを結果に書くことが書かれ、起動していない実行の文は無い
- [TV-3] 転送しなかった番号と TCP 以外のポートの注記がスキルに出ること
  - 入力：2 つのサービスが同じポート 8080 を使い、1 つが UDP のポートを持つサービスを起動して実行する
  - 期待結果：SKILL.md のサービスの行に、localhost:8080 は複数のサービスが使う番号のため転送していないことと、UDP のポートは localhost に転送していないことが書かれる
- [TV-4] スキルの description が、リポジトリの手順より先に読むものだと分かること
  - 入力：serviceSkill の起動した・しなかったの両方の出力の frontmatter
  - 期待結果：description が両方で同じで、docker・docker compose・DB（MySQL・PostgreSQL・Redis）・キャッシュ・モックの API を起動する・つなぐときに、リポジトリのスキル・手順より先に読むことを書いている
- [TV-5] スキルの本文が sacty や特定の言語・DB に寄せていないこと
  - 入力：serviceSkill の起動した・しなかったの両方の出力の本文（frontmatter を除く）
  - 期待結果：本文に sacty・Sacty の語と、MySQL・PostgreSQL・Redis などの製品名・特定の言語の名前が含まれない
- [TV-6] 工程の指示に、スキルを先に読む 1 行が起動の有無によらず入り、接続先の候補が起動時の指示にも残ること
  - 入力：サービスを起動した implement と、起動しない review の工程の指示
  - 期待結果：両方の指示に、docker・DB などが要るときはリポジトリのスキル・手順より先にスキル docker-services を読む 1 行があり、起動時はスキルと同じ接続先の候補があり、起動しないときは接続先の行が無い
- [TV-7] 層の同じ名前のスキルが、sacty の作るスキルを上書きしないこと
  - 入力：プロジェクトのコンテキストに skills/docker-services/SKILL.md を置いて工程を実行する
  - 期待結果：置かれる SKILL.md は sacty が作った中身で、層のものは写さず、コンテキストの注意に context.reservedSkill が記録される
- [TV-8] Codex で、スキルの一覧に docker-services が出ること
  - 入力：Codex のエージェントで工程を実行する
  - 期待結果：AGENTS.md のスキルの一覧に、docker-services の description と設定の場所の skills/docker-services/SKILL.md のパスの行がある
- [TV-9] review スキルの検証の手順に、サービスが要る検証の扱いが書かれていること
  - 入力：skills/review/review-dispatch/references/verification-run.md の差分
  - 期待結果：DB などのサービスが要る検証は docker-services に従い、確かめられなかったことをレビューの本文に書くことが書かれている
- [TV-10] 仕様書とユーザー文書（日英）が今回の振る舞いを書いていること
  - 入力：docs/spec/services・context と docs/user/compose・context の日英の差分
  - 期待結果：スキル docker-services を工程の実行に置くこと、起動した・しなかったの中身（接続先は候補で、届かなければ別の候補を試し、それでも届かなければ確かめられなかったと書くことを含む）、工程の指示の 1 行、層の同じ名前のスキルは使わないこと（context.reservedSkill）が日英の両方に書かれ、servicePromptLines の接続先をスキルと同じ候補として案内する記述がある
