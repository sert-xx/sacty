# sacty コマンドの入口を mise に登録するのをやめ、いつも ~/.local/bin などに置く

- 日付: 2026-11-18（UTC）
- タスク: なし
- PR: #432
- ブランチ: claude/magical-meitner-j348hd
- 関係する ADR: [sacty コマンドの入口を mise に登録するのをやめ、いつも ~/.local/bin などに置く](../adr/20261118-1322-cli-install-without-mise-registration.md)

## 目的

mise を使う環境で、`npm run cli:install` の入れ方（入口を `mise link` と `mise use --global` で mise に登録する）がうまくない、とリポジトリの持ち主から報告があった。
持ち主が検討していた、mise の設定の `_.path` にリポジトリの `bin` を足す案と比べたうえで、mise に登録せず、いつも `~/.local/bin`（`SACTY_BIN_DIR` があればそこ）に入口を置くことにした。

## したこと

レビューの対応を終えた時点の差分で書いている（途中で書いて、後で直した内容は、「レビューの指摘と対応」にある）。

- `scripts/cli-install.mjs`：mise に登録する処理（`useMise`・`miseToolDir`・`installWithMise`・`checkMise`）を消し、いつも `launcherDir` の場所に入口を置くようにした。`mise` は呼ばない。
  前の版が mise に登録した入口があれば、置いた入口と同じ中身に書き直し（`legacyMiseRoot`・`refreshLegacyLaunchers`）、手で外す手順を注意に出す（`legacyNotice`）。
  テストから偽のリポジトリで動かせるよう、`main` を `repo` を受け取る形にして公開した。
- `tests/scripts/cli-install.test.ts`：消した関数のテストを消し、前の版の入口の書き直し・注意・`main` の流れのテストを足した。
- 仕様書（`docs/spec/architecture.md` と英語の版）・ユーザードキュメント（`docs/user/getting-started.md` と英語の版）を、今の動きに合わせた。
- ADR を足し、前の ADR を、一部の置き換えとして `superseded` にした（本文は書き換えていない）。名前の変更で切れるリンク（前の ADR を指す ADR と作業履歴）を直した。

## 確かめたこと

- `npx vitest run tests/scripts/cli-install.test.ts`：通った。
- `npm run lint`・`npm run typecheck`・`npx vitest run tests/docs`：通った。
- `npm test`：5 ファイルの 8 件が失敗した（`apps/daemon/src/agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts`、`apps/web/src/components/question-form.browser.test.ts`・`shell/menus.browser.test.ts`）。
  この変更を外した状態でも同じ 8 件が失敗した。確かめた環境の Node.js は 22.23.5 で、リポジトリが求める版（26.13.1）ではない。失敗の原因は調べていない。
- はじめの実装（`mise unuse` で外す）は、仮のホームと偽の `mise` で `node scripts/cli-install.mjs` を実行して確かめた。レビューの後の実装は、同じ流れを `tests/scripts/cli-install.test.ts` の `main` のテスト（偽のリポジトリ・仮のホーム・呼ばれたら記録する偽の `mise`）で確かめている。
  - mise があるとき：`mise` は呼ばれず、`~/.local/bin/sacty` に入口が置かれ、入口の `--version` が版を出す。
  - 前の版の入口があるとき：前の版の入口が、置いた入口と同じ中身になり、手で外す手順の注意が出て、終了コード 0 で終わる。
- レビューの対応の後：`npx vitest run tests/scripts/cli-install.test.ts`（21 件）・`npm run lint`・`npm run typecheck`・`npx vitest run tests/docs` が通った。
- 確かめられなかったこと：実際の mise での動き（この環境に mise を入れられなかった。配布元への通信が通らない）。登録が残っている間に mise がどちらの入口を先に見つけるか、文書に書いた手で外す手順で登録が外れるかは、確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 前の版の登録が見つからなくても `mise unuse --global sacty` を実行し、ほかの方法で入れた sacty まで設定から外しうる | 自動で外すのをやめた（レビューの別案）。`mise` は呼ばず、前の版の入口を同じ中身に書き直して、手で外す手順を注意に出す。対象を版に限って `unuse` する直し方は、実際の mise で確かめられない操作が残るので採らなかった |
| 後始末の `readdirSync`・`rmSync` の例外を捕まえておらず、`mise` の起動の失敗の原因も注意に出ない | 消す処理と `mise` の呼び出しが無くなった。書き直しの例外は捕まえて、書き直せなかった入口として注意に出す（テストあり） |
| ユーザードキュメントで、前の版の登録の話が置き場所の箇条書きに混ざり、手で消す手順が無い | 置き場所の箇条書きから外し、前の版を mise で入れていた人への段落に、書き直すこと・手で外す手順・確かめ方を書いた（日英） |
| テストが版1つの場合だけで、`main` の流れのテストが無い | 版が複数・目印の無いファイル・ディレクトリでない場合のテストと、`main` を別のプロセスで動かすテスト（mise を呼ばない・終了コード 0）を足した |
| ADR が、確かめていない前提を事実として書き、登録を続ける案を比べていない | `PATH` の前提を未確認と書き、背景の弱い所が作者の推測であること・確かめ方を書き、登録を続ける案を比べた案に足した |
| （2回目）前の版の入口が `PATH` で先に見つかると、「そちらを消すか」の注意と「同じに動くよう書き直しました」の注意が並ぶ | 先に見つかるのが書き直した前の版の入口なら、`checkPath` の注意を出さず、同じ中身で同じに動くと知らせる（`main` のテストあり） |
| （2回目）注意が「登録が残っています」と言い切るが、出る条件は入口のディレクトリがあることだけ | 注意・文書（日英）・仕様書・ADR を、「ディレクトリがある。登録が残っていれば外す」の形に揃え、`mise ls sacty` での確かめを足した |
| （2回目）手で外す手順が、mise の既定の場所だけで、シムの片付けが無い | `MISE_DATA_DIR`・`XDG_DATA_HOME` を指定した場合の場所と、`mise reshim` を足した。実際の mise では確かめていない |
| （2回目）版の確かめより前に前の版の入口を書き直すので、確かめに失敗すると、動かない中身が前の版の入口に写る | 版の確かめを通った後に書き直す順にした（テストあり） |
| （2回目）`main` のテストが成功の場合だけ | 置き場所に sacty のものでないファイルがある場合・版が違う場合・前の版の入口が先に見つかる場合を足した。前の `npm link` を外す分岐は、この PR で変えていないので足していない |
| （2回目）ADR の「mise も既定で `~/.local/bin` に入る」に根拠も未確認の注記も無い。`_.path` に専用のディレクトリを足す案を外す理由が、案の欠点になっていない | 作者の知識で確かめていないと書き、持ち主の環境の `PATH` を確かめていないことを「影響」に足した。案を外す理由を、案の側の欠点で書き直した |

## 残したこと

- 持ち主の環境で、`~/.local/bin` が `PATH` に入っていることを確かめる。
- 実際の mise のある環境で、入れ直した後にどのディレクトリでも `sacty` が動くことと、文書の手順で前の登録が外れることを確かめる。
