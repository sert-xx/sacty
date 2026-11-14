**日本語** | [English](context.en.md)

# コンテキストの合成

工程のエージェント・情報収集・オーケストレーターに渡す規則・スキル・MCP サーバー・外部 PF・エージェントの設定を、コンテキストと呼ぶ。
sacty はコンテキストを層を重ねて合成し、実行のたびに Claude Code・Codex の設定の場所に置く。
層は、sacty の既定のコンテキストと、プロジェクトに指定したコンテキストリポジトリ（と、その継承の鎖）。

関係する ADR: [既定の review スキルは、対象のリポジトリのレビュー用のスキルを追加の担当として実行し、開発向けの指示への準拠を観点 X-3 で見る](../adr/20261112-0040-review-uses-repo-skills-and-instructions.md)、[プロジェクトのコンテキストで、ホストの Claude Code・Codex を利用者のログインのまま対話で起動する CLI を足し、作業履歴には記録しない](../adr/20261110-0011-launch-local-agent-with-project-context.md)、[コンテキストの mcp.yaml の command の MCP サーバーを、既定でホストで起動してゲートウェイ経由にする](../adr/20261014-0927-context-command-mcp-on-host.md)、[既定のコンテキストに文章を書くためのスキルを同梱し、「。」の後の改行は日本語だけにする](../adr/20261015-0844-default-writing-skill.md)、[コンテキストに、ローカルのディレクトリの今の中身とモノレポの中のディレクトリを使えるようにし、extends に相対パスを足す](../adr/20261022-0626-context-local-path-and-monorepo.md)、[コンテキストのリポジトリのサブモジュールを取得し、組織で別に管理するスキルなどを写さずに使えるようにする](../adr/20261022-1503-context-submodules.md)

## 層

層は上位から重ね、下位の層が `extends` で上位の層を指す。

![コンテキストの層と継承](images/context-layers.svg)

- 層の順は、上位から次のとおり。
  1. sacty の既定のコンテキスト（`apps/daemon/default-context/`）。
     取得せずに同梱のものを読む。
     名前は `sacty-default` で、コミットの代わりに中身の SHA-256 を記録する。
  2. コンテキストリポジトリの継承の鎖の最も上の祖先 → …
  3. プロジェクトが指定したリポジトリ（最下位）
- プロジェクトの指定（`ContextSource`）
  - `repo`：git の URL かローカルのパス（500 文字まで）。
    ローカルのパスは、絶対パスか `~/` で始まるもの（`~` はホームのディレクトリ）。
  - `ref`：ブランチやタグ。省けば、git の URL は既定のブランチ、ローカルのパスはディレクトリの今の中身。
  - `path`：リポジトリの中のディレクトリ（モノレポの一部を層にする）。リポジトリの根からの相対パスで、`.`・`..` の部分は書けない（`input.invalidContextPath`）。省けばリポジトリの根。
- 層は `<repo>//<path>#<ref>`（`path`・`ref` はあるときだけ）で表す。
  作業履歴（`ContextResolved` の `layers`）には `repo`・`ref`・`path`・`commit` を記録する。
- 継承：`sacty-context.yaml` の `extends` に、次のどれかを書く。
  - `<URL>[#<ref>]`：ほかのリポジトリ（最後の `#` で分ける）。
  - `{ repo, ref, path }`：ほかのリポジトリの中のディレクトリ（`ref`・`path` は任意）。
  - `./`・`../` で始まる相対パス：同じリポジトリ・同じ `ref` の中の、その層のディレクトリから見たディレクトリ。
    リポジトリの外を指したら `context.extendsOutside` で止める。
  - git で取得した層（`ref` のあるローカルのパスを含む）は、ローカルのパスを継承できない（`context.localExtendsFromRemote`）。
    別のリポジトリとして継承できるのは、`https://`・`http://`・`ssh://`・`git://` の URL と `user@host:path` の形だけ（`file://`・`sibling/repo.git` のような相対パス・`ext::` などは止める）。`./`・`../` で始まる、同じリポジトリの中の相対パスは継承できる。
    `user@host:path` の形（最初の `:` より前に `/` が無い指定）は、空のディレクトリで `git clone` する（デーモンのカレントディレクトリにある同じ名前のディレクトリを、git がローカルのリポジトリとして読まないため。`GitContextFetcher`）。
    ローカルのパスを書けるのは、プロジェクトの指定と、`ref` の無いローカルのパスの層（今の中身を読む層）の `extends` だけ。
  - 同じ層（`repo`・`path`・`ref`）が2度出たら `context.cycle` で止める。
  - 深さが `MAX_CONTEXT_DEPTH`（10）に達したら `context.tooDeep` で止める。
- 取得はキャッシュしない。合成のたびに一時ディレクトリ（`sacty-context-*`）に置き、使い終わったら消す。
  - git の URL と、`ref` のあるローカルのパス：`git clone --depth 1 [--branch <ref>]` する。
    同じ合成の中では、同じ `repo#ref` を1回だけ取得し、中のディレクトリの違う層は同じ取得（同じコミット）を使う。
  - `ref` の無いローカルのパス：取得せず、層のディレクトリ（`<repo>/<path>`）を `.git` を除いて写す。
    写すのとハッシュは非同期に行い、ファイルは少しずつ読む。中止（上限の時間）されたら途中で止め、`context.copyAborted` で止める。
    git で管理していなくても、コミットしていない変更があってもよい。
    リンクはたどらずにリンクのまま写す。
    コミットの代わりに、写した中身すべての SHA-256 を記録する。
  - サブモジュール
    - git で取得した層：層に関わるサブモジュールを `git submodule update --init [--recursive] --depth 1 -- <パス>` で取得する。
      - 層のディレクトリの中にあるもの：入れ子も含めて取得する（`--recursive`）。
      - 層のディレクトリを含むもの（層がサブモジュールの中にある）：そのサブモジュールだけを取得し、その中で層への相対パスで選び直す（その中の、層に関わらない入れ子は取得しない）。
    - 取得するのは、取得したコミットが指すサブモジュールのコミットなので、記録するのは取得したリポジトリのコミットだけ。
      層に関わらないサブモジュール（モノレポのアプリのものなど）は取得しない。
      同じ取得の同じ層のディレクトリでは1回だけ取得する。
    - ローカルのパス（file のプロトコル）のサブモジュールは取得しない（`protocol.file.allow=never`）。
      取得したコミットの中身で、ホストのディレクトリを読ませないため（`extends` のローカルのパスと同じ）。
    - 認証は、リポジトリと同じ環境変数で取得する。
      gh のトークン（`http.https://<ホスト>/.extraheader`）を渡すのは、リポジトリが HTTPS の URL のときだけで、効くのは同じホストの HTTPS の URL のサブモジュールだけ。
      SSH の URL・ほかのホストのサブモジュールは、ホストの git の認証（SSH なら `SSH_AUTH_SOCK`）を使う。
      取得できなければ `context.fetchFailed` で止める（git の誤りの文をそのまま渡す）。
    - `ref` の無いローカルのパス：層のディレクトリの下のサブモジュール（入れ子も）が取り込まれていなければ（サブモジュールの `.git` が無ければ）、`context.submoduleNotCheckedOut` で止める。
      ホストのディレクトリは変えないので、sacty からは取り込まない。
      git で管理していないディレクトリ（`git ls-files` が失敗する）には、サブモジュールは無いものとする。
    - サブモジュールの中身も、ほかのファイルと同じく、シンボリックリンクがあれば止める。
  - 層のディレクトリが無い・途中にシンボリックリンクがあるときは `context.pathMissing` で止める。
  - git に渡す環境は `GIT_TERMINAL_PROMPT=0` とホストの `PATH`・`HOME`・`SSH_AUTH_SOCK`・`TMPDIR`・`LANG` と認証だけ。
- 認証
  - HTTPS の URL で、次のどちらかに当たれば、gh のトークンを `http.https://<ホスト>/.extraheader` の設定（環境変数 `GIT_CONFIG_*`）で渡す。
    - そのホストの GitHub のアカウントをプロジェクトで選んでいる。
    - プロジェクトの対象に同じホストがある。
  - アカウントが要るのに選んでいなければ止める（`github.accountRequired`）。
  - SSH・ローカルのパス・ほかのサーバーは、ホストの git の認証を使う。
  - トークンは誤りの文から伏せる。

コード: `apps/daemon/src/context.ts`（`loadLayers`・`loadDefaultContext`・`resolveContext`・`parseExtends`・`extendsRef`・`localContextDir`・`layerDir`・`copyLocalLayer`・`hashTree`・`assertSubmodulesCheckedOut`・`gitlinks`・`submoduleInLayer`・`GitContextFetcher`・`MAX_CONTEXT_DEPTH`・`DEFAULT_CONTEXT_REPO`）、`apps/daemon/src/service.ts`（`gitAuth`・`githubToken`）、`apps/daemon/src/gh.ts`（`gitAuthEnv`）、`packages/core/src/projects.ts`（`ContextSource`・`ContextPath`・`contextLabel`）

## 既定のレビュー用スキル

既定のコンテキストには、レビューを観点ごとに分担する `review-dispatch` と `review-execution` がある。
既定のスキルは、あらゆる言語・分野のリポジトリと sacty の外の使い方に渡るので、sacty に限った書き方をしない。

親は担当を起動する前に、対象のプロジェクトで定められたフォーマッター・リンター・型チェック・テスト・ビルドの検証を、対象を変更しない方法で1回実行する。
結果は作業領域の外に要約とログとして保存し、各担当へ同じ要約を渡す。
横断の観点 X-1 は常に起動し、検証または CI の結果があれば X-2 が失敗・警告・未実行の検証を分析する。
再レビューでは新しい対象に対して検証し直す。
同じ内容で前の段（CI・依頼文が渡した記録）が全体を実行して結果が出ている検証は、実行し直さずに使い回し、覆われていない分だけを実行する（手順の「1.5 使い回せる結果を探す」。PBI-305）。一部だけを実行した結果は、その範囲だけを覆ったものとし、段階・分割で実行する CI は、定義とログから全体を覆うと確かめたものだけを実行済みにする。CI が無い・読めないときは、CI で実行されたものとして扱わない（[同じ内容の検証の使い回し](tasks-and-steps.md#同じ内容の検証の使い回し)）。
主対象が文書（`design-doc`・`user-doc`）のレビューでは、`self-review`・`pr-review` のどちらでも、変えた文書に効く検証（文書のフォーマッター・文書の lint・リンクの検査など、リポジトリにあるもの）だけを実行し、テスト・ビルド・型チェック・コードのリンターは実行しない。文書に効く検証が無ければ何も実行しない。対象のファイルを引数で絞れず、コードも検査してしまうものは実行しない。レビューの範囲の差分にコードの変更が含まれるときは、主対象が文書でも全部を実行する。文書とコードの両方を変える PR（主対象が `code`）も全部を実行する。
`summary.json` の `scope`（`all`・`docs`。`docs` は、主対象が文書で、差分にコードの変更が無いときだけ）に実行した範囲を残し、X-2 は `docs` のとき、意図して実行していない検証を指摘しない。`docs` のとき、X-2 は文書に効く検証を実行したときだけ起動する（自己レビューの再レビューは下の規則）。`all` のときは、主対象が文書でも、検証の結果か CI の結果があれば起動する。省くのはコードの振る舞いを確かめるテストで、テストランナーで書かれた文書だけの検査（リンク・参照・生成物の一致など）は、文書に効く検証として実行する。`docs` のときは、CI の結果は渡さず（`ci` は `null`）、CI の結果だけでは起動せず、CI に失敗したチェックがあればレビューの範囲に 1 行書く。`all` のときは、CI の結果を `ci` に入れて X-2 に渡す。

自己レビュー（`self-review`）の再レビュー（2回目以降）は、前回の回で `must` を出した観点と X-1 だけを起動する（PBI-286。実験 F31）。
`must` が無く、`should`・`nit` だけを直して再レビューに進むときは、X-1 だけを起動する。
決めるのは前回の回の結果だけで、必須観点を全部起動する・条件付き観点の起動条件を判定し直す、という初回の規則は再レビューでは使わない。
起動した担当には、その観点の前回の指摘と修正の内容を渡し、直ったかと、修正が新しい問題を持ち込んでいないかを見させる。X-1 には、前回の回で採用した指摘のすべてと修正の内容を渡す。起動しなかった観点が見るはずの問題を、修正が持ち込んでいたときは X-1 が拾う。
起動しなかった観点は、起動表に「起動しない」と理由（再レビュー：前回の回で `must` なし）を残し、成果の説明の「起動した観点」でも分かるようにする。
X-2 も同じ扱いだが、修正後に実行し直した検証が失敗・警告を出したときは X-2 も起動する。
再レビューでも検証の範囲（`scope`）は決め直す。`scope` が `docs` のときは、実行し直した文書に効く検証が失敗・警告を出したときに X-2 を起動し、実行した検証が 1 つも無ければ、前回の回で `must` を出していても起動しない（分析するものが無い）。修正で差分にコードの変更が入れば `scope` は `all` になり、検証は全部実行する。
初回のレビューと、PR のレビュー（`pr-review`）の再レビューの起動の規則は変えない。

自己レビューでも、作業の指示が「この実行は、人の差し戻し・AI のレビューの指摘・検証の不合格を受けた直しである」と示したうえで、「この実行の最初のセルフレビューを、直しの実行の最初のレビューの規則で行う」と明示しているときに限り、その実行の最初のレビューを再レビューとして扱う（PBI-296。実験 F39）。明示が無いとき（タスクの最初の実行、または「差し戻しの直し」「レビューの範囲を絞る」としか書かれていない実行、前回のセルフレビューが合格していない実行）は、観点を絞らず、初回の規則で全部の観点で見る。
起動するのは、今回の指摘に関わる観点と X-1 だけ。関わる観点は、指摘が観点の ID を示していればその観点、示していなければ指摘が述べる問題を観点カタログの「見るもの」に当てはめて選ぶ。検証の不合格は、不合格の理由（満たしていない要件・失敗したテスト・再発した指摘）ごとに同じ方法で選ぶ。決められない、または境界にまたがるときは、当てはまりうる観点をすべて起動する。
X-2 は、指摘が検証の失敗に関わるとき、または実行し直した検証が失敗・警告を出したときだけ起動する。対象は、この実行で直した箇所とその直しが直接必要にした既存の箇所。
起動した担当には、今回の指摘と直しの内容を渡し、直ったかと、直しが新しい問題を持ち込んでいないかを見させる。起動しなかった観点は、起動表に「起動しない」と理由（直しの実行：今回の指摘に関わらない）を残し、成果の説明の「起動した観点」でも分かるようにする。この実行の中の次の回からは、上の再レビューの規則どおり。

設計書・要求要件（`design-doc`）の必須の観点には、書きすぎを探す D-10（簡潔さ・範囲）がある。
依頼に無い要求、読む人がすでに知っていること（依頼の言い直し・背景・一般論・既存のコードの説明）、既存の仕組みが保証する振る舞いの書き直し、今回の変更で起こりえない異常系、当てはまらない観点の「対象外」、採らなかった案、重複、人間が判断することが冒頭で分かるか、分量が最小限かを見る。
人間が差し戻しで求めて足した記述は、削る指摘にしない。
リポジトリの決まり（README・CONTRIBUTING・AGENTS.md・CHANGELOG の方針・PR テンプレート・CI の設定など）が、この種の変更に求める条件（版・変更履歴・生成物・ドキュメントの更新など）と、その確かめ方も、削る指摘にしない。決まりは変更する人が守って成り立つもので、既存の仕組みが保証する振る舞いではないため。決まりの出典（ファイルと節）を引ける条件は残させ、条件の中身が誤っている・確かめられないときは、消さずに直す指摘にする。
欠落を探す観点だけでは、自己レビューを回すほど文書が長くなるため。
D-3（完全性）は、今回の変更で起こりうる欠落だけを見て、関係しない観点に「対象外」の記載を求めない。
自己レビューでは、`design-doc` の記述を足す指摘は `must` だけを直し、`should` は直さない（足りない所は、読む人が求めたときに足す）。D-10 は `should` も直す（ただし、決まりから導いた条件は消さず、消すときは理由を総評に残す）。
`design-doc` の D-6（形式・明確さ）は、（要求要件・設計など、人が承認する成果物のとき）本文に残った作業の経過・指摘への対応の報告・エージェント向けのメモ、本文で振る ID（要求の `R-n` など。sacty が振るテスト観点の `TV-n` は除く）の理由の分からない欠番、別の文書を参照するだけの項目も見る。ID を持たない文書や、経緯を書く節がある文書（ADR・CHANGELOG など）では見ない。
D-10 は、「確認したいこと」「既定で決めたこと」の節がある文書で、依頼の目的に関わる判断や依頼者に不利益が出うる既定が「既定で決めたこと」に紛れていないか、「確認したいこと」が依頼者が一番決めたいことから並んでいるか、項目ごとに確認しない場合の具体的な懸念があるかも見る。
要求要件・設計では、スコープ（何を実現するかと、対象・対象外）が最初にあるかも見る。スコープの「対象外：なし」は、考え忘れと区別するために書くもので、書きすぎとして消させない。
本文に残ったメモ、参照だけの項目、目的に関わる判断・不利益な既定の紛れ込みは `must`、本文で振る ID の理由の分からない欠番は `should` の指摘にする。
D-10 は、リポジトリの文書（README・AGENTS.md から参照されていないものを含む）や既存の振る舞いに根拠のある記述を、「依頼に無い」だけを理由に消す指摘にしない。消す前に根拠を探し、根拠があれば `checked` に書いて残すか、残すかを人に確かめる「確認したいこと」に回す指摘にする（PBI-301 A4。実験 S14 r4：運用の文書に根拠のある「作成・キャンセル後に取り直す」を消した）。
U-1（正確性・コードとの同期）は、名前・値（コマンド・設定のキー・パス・既定値）の照合に加えて、文書が述べる責務・振る舞い（「A が B をする」）を、述べられた主体の本体を読んで該当するコードと照らす。名前が実在することだけで合格にしない（PBI-301 A1。実験 S2 r4）。
U-1 が検証できる記述を拾うのは、依頼文の範囲の中だけ。範囲が変更（PR 全体・今回の変更など）なら、差分で変えた・足した記述と、差分の変更で正しさが変わりうる記述に限り、差分に関係しない節は同じファイルにあっても拾わない。対象の文書を全体で渡されたときは全体から拾う。範囲の外を見なかったことは、担当の `failed` の理由にしない（PBI-343）。
`pr-review` で、起動し直しても `failed` の観点が残ったときは、見られた観点で採用した `must` があれば判定を「修正が必要」にし、無ければ判定を書かない（PBI-343）。
検証の実行の手順（`verification-run.md`）は、0〜5 の全体を読んでから実行する。見出しや一部の行だけを読んで進めず、フォーマッター・リンターは成果物として足すファイルにも効くので、主対象の種類にかかわらず実行する範囲に入れる（PBI-301 A3。実験 S18 r4）。
`self-review` で `scope` が `all` のときのテストは、回ごとには変更に関係するものだけでよい（選び方はテストの実行器の絞り込みで決め、決められなければ全件）。全件は修正を終えた後に1回実行し、全件の結果が無いまま提出しない（実行するテストがあるときだけ。テストの仕組みが無ければ当てはまらない。PBI-316。[タスクと工程：実装の途中のテストの範囲](tasks-and-steps.md#実装の途中のテストの範囲)）。

コードの必須の観点には、要らないコードを探す C-15（簡潔さ・範囲）がある。
依頼のどれのためにもない変更、起こりえない状態への防御、使われないコード、今回の変更で使われなくなった既存のコードの消し忘れ、1 つしか実装の無い抽象化、言い直すだけのコメント、重複したテスト、残す理由の無い互換のための層を見る。
消してよいと言う根拠（呼び出し元が無い・起こりえない）はコードで確かめさせ、外部に公開する I/F は消す指摘にしない。
C-5（保守性・設計）は要らないコードを見ず、C-15 に任せる。

コードの必須の観点には、問題を解く方針そのものを見る C-17（方針の妥当性）もある（PBI-342）。
もっと単純で確実な方針（問題の入力を受け付けない・許可したものだけ通す・既存の仕組みに任せる・問題の起きる経路をなくす）が無いか、問題の重さとタスクの制約（最小限の変更・範囲・行数の上限）に釣り合うか、境界の場合を際限なく生む形でないかを見る。
別の方針で失うもの（使えなくなる正当な使い方）を確かめて指摘に書かせ、承認済みの要求要件・設計が決めた方針は変える `must` にしない。
指摘は1回のレビューで出し切る。担当は欠陥ごとに同じ原因のほかの現れ（入力の形の違い・別の箇所）を探して1件にまとめ、親は観点をまたいで同じ原因の指摘を1件にまとめる。直し方は個々の現れではなく原因に向ける。
再レビュー（`self-review` の2回目以降と直しの実行の最初のレビュー、`pr-review` の再レビュー）で、前回までの `must` と同じ原因の別の現れがまた見つかったら、現れをもう1件足さず、C-17 の担当に方針を見直させる（C-17 を起動していなければ起動し、起動していても方針を変える指摘が出ていなければ、今回の現れを渡して1回だけ起動し直す）。C-17 が方針を変える指摘を出せば現れをそこにまとめ、出さなければふつうの `must` にする。主対象が `design-doc` なら、C-17 の代わりに D-1（代替案）で同じように扱い、`user-doc` には当てはめない。
現れを方針の指摘にまとめるのは、方針の指摘が `must` のときだけで、まとめた指摘の重要度は最も高いものにする。方針の指摘が `should`（承認済みの設計が方針を決めているときなど）なら、`must` の現れはまとめずに残す。
担当への依頼文には、観点の資料（`review-execution` の `references/<観点ID>.md`）が無いときは「見るもの」「見ないもの」だけで見て、資料が無かったことを `limitations` に書くこと（それだけで `failed` にしない）を入れる。`review-execution` だけを古い版で差し替えた環境でも、新しい観点の担当がレビューを完了できるようにするため。
PR のレビューの子タスクの指示（`buildPrompt` の `review`）も、指摘を出し切ること、再レビューで同じ原因の別の現れが続いたら上の集約の規則どおりに扱うこと（方針の観点に見直させ、方針を変える `must` が出なければ現れを `must` のまま残す）を書く。

画面・UI コンポーネント・スタイル・フォームを変えるときは、C-13（UI・アクセシビリティ）に加えて、利用者が目的を達せるか（入口・手数・フィードバック・情報の配置・既存の画面との一貫性・誤操作・見た目の崩れ）を見る C-16（UX・利用者の流れ）を起動する。
C-13 か C-16 を起動するとき、親は担当を起動する前に、すでにある Playwright とブラウザが動き、アプリを起動する方法が見つかる場合だけ、アプリをローカルで起動して変更した画面を撮る（画面の幅・状態・操作の順。変更前も撮れれば撮る）。
Playwright やブラウザを新たに入れない。
画像と `screens.json` は検証の結果と同じく作業領域の外に保存し、C-13・C-16 の担当にだけ渡す。
撮れないとき・途中で失敗したときは画面を諦めて理由を記録し、担当はコードを読んで確かめる（それだけで観点を `failed` にしない）。
途中までに撮れた分があれば渡し、担当は撮れなかった分だけをコードで確かめる。

対象のリポジトリが持つレビュー用のスキルと開発向けの指示（開発用のスキル・指示書）も、レビューに使う（PBI-326）。
親は担当を起動する前に、対象のリポジトリの中（ルートと、変更したファイルの上位のディレクトリ）を探し、見つけたものをレビュー用・開発用・使わないものに分ける。
拾うのは、そのリポジトリで開発する人やエージェントに向けて置かれたもの（エージェントが読み込む置き場にあるものと、指示書・README・`CONTRIBUTING` から参照されているもの）だけにする。
親に渡された設定の場所のスキル（既定のスキルと、プロジェクトのコンテキストのスキル）、リポジトリが製品として配る・試験に使うスキルや指示書（製品のソース・テストの fixture・例・テンプレート）、依存として取り込んだ他者のコードの中の指示は数えない。
探す置き場は特定のツールに限らない（`.claude/skills`・`.agents/skills`・`.github/`・`.cursor/`・`AGENTS.md`・`CLAUDE.md`・`CONTRIBUTING` などは例）。

- レビュー用のスキル（レビューの観点・チェック項目・手順を定めるもの）は、今回の変更に当てはまり、基準にできるもの 1 件につき、担当を 1 つ（R-1・R-2…）起動する。担当はスキルの項目を見て、結果を既定の出力の形式に写す。段階は `advanced`。
- 開発向けの指示（成果物の作り方の決まりを定めるもの）は、今回の変更に当てはまり、基準にできるものが 1 件以上あれば、X-3（リポジトリの指示への準拠）の基準にする。X-3 は、指示が明文で求める決まりのうち、守ったかを成果物（差分・コミット・PR の本文・書き出した文書）から確かめられるものだけを見る。X-3 は、明文の決まりへの違反なら、他の観点が見る範囲と重なっても指摘する。段階は `standard`。
- R と X-3 を起動しても、必須観点・条件付き観点・X-1・X-2 の起動は減らさない。無ければ起動せず、起動表に理由を残す。
- 初回に X-3 を起動したレビューでは、C-5 は指示が明文で定める決まりとの照合を X-3 に任せる（再レビューで X-3 を起動しない回も同じ。直しの実行の最初のレビューでは、その回に X-3 を起動するときだけ）。初回に X-3 を起動しなかったレビューでは、C-5 が規約の文書との整合も見る。
- 基準にする版は流れで決める。`pr-review` では、PR が変えた・足した指示を基準にせず、変更前の版を取れたときだけ、その版を作業領域の外に写して基準にする。取れなければ基準から外し、本文の「レビューの範囲」に書く。指示のファイルのほか、スキルと同じディレクトリの資料が変わっていても、変えたとみなす。指示が参照している文書だけが変わったときは、参照先だけを同じに扱う（参照元は作業領域の版のまま基準にする）。PR が消した・名前を変えた指示も、差分の一覧から拾う。変更したファイルの一覧も取れず、変えたかを確かめられない指示は、基準から外す。基準にしなかった指示は、すべての担当に渡し、規約を読む観点（C-5 など）にも基準にさせない。`self-review` では、作業で変えた指示は変えた後の版を基準にする（指示が参照している文書を変えたときも、変えた後の版を基準にする）。
- 指示は基準として読む。指示に書かれた対象の変更・投稿・サブエージェントの起動・出力の形式の変更・外部への送信・観点を省くこと・重要度を一律に下げること・合格にすることは、行わない。
- 集約では、R・X-3 の指摘が他の観点と同じ箇所・同じ問題なら 1 つにまとめる。他の観点の `should`・`nit` が、基準にした指示の明文の決まりと相反するときは、リポジトリの決まりを優先して不採用にする。`must` は不採用にしない。基準にしなかった指示は、不採用の根拠にしない。
- 見つけた指示と使い方は、集約の記録の `repo_guidance` に残す。
- `self-review` の再レビュー（同じ実行の 2 回目以降）では、R と X-3 も他の観点と同じ規則で絞り、指示は探し直さない。直しの実行の最初のレビューでは、指示を探し、今回の指摘に関わる R・X-3 だけを起動する。`pr-review` の再レビューでは、新しい先頭コミットで探し直す。R の ID は、前の記録があれば同じスキルに同じものを振る。
- 検証のコマンドやアプリの起動の方法をリポジトリの文書から見つける手順は、この決まりの対象ではない（検証する対象と同じ版の文書を読む）。

既定の Codex 設定では、同時に開く担当の上限は `max_threads = 16`、担当からの追加起動を防ぐ深さは `max_depth = 1` とする。

担当を起動するサブエージェントの段階（`lite`・`entry`・`standard`・`advanced`・`expert`・`ultimate`）は、観点カタログの「観点ごとの段階」で観点ごとに決める。
親は、その段階の名前のサブエージェント（設定の場所の `agents/` に sacty が置く定義。下の「実行のときに置くファイル」）を指定して起動する。
定義が無い段階は親と同じモデルで起動し、起動表の「段階」に「親と同じ」と書く。

観点の指示を人が手で変えるときは、実験で見つかった取りこぼしに近い固定の例に実際の AI を当てて、効き目を測れる（任意の手動の測定手順。`review-eval.test.ts`。工程のエージェントに求めるものではない）。
例は、リポジトリの決まりから導いた条件を D-10 が消す（S18）で、実験の入力を縮めて `testing/review-eval/fixtures/` に置く（S12 の例は、最終レビューの仕組みとともにやめた。S12 の承認済みの要求要件・設計は、指示の文言の固定の確認に使う）。
固定の確認（例が問題の形になっていること・指示の文言・判定の読み取り）は、テストの実行で常に走る。
AI を呼ぶ確認は `SACTY_REVIEW_EVAL=1` のときだけ走り、指示の変更の前後で同じ例を複数回（`SACTY_REVIEW_EVAL_RUNS`）流して比べる。
D-10 は決まりから導いた条件を消す・縮める指摘を出さず、ほかの書きすぎは指摘することを確かめる。

### PR のレビューと投稿

PR のレビュー（流れ `pr-review`）と、既定の `git` の PR への投稿は、次のように動く。

- 依頼した側（呼び出したツールやプロンプト）が出力の形と投稿のしかたを決めていれば、それに従い、エージェントは自分で投稿しない。
  sacty の PR のレビューのタスクは、指示で出力の形を決め、投稿は sacty がする（[タスクと工程](tasks-and-steps.md#pr-のレビューだけのタスク)）。
- 決めていない（人が対話で投稿を頼んだ）ときだけ、`git` の手順で 1 件の `COMMENT` のレビューとして投稿する。
  - 指摘の頭は `[要修正]`・`[提案]`。
  - 判定は「修正が必要」「提案あり（マージは可）」「指摘なし」の3つ。
  - 差分の中に付けられる行が無い指摘は、確かめる相手（対話で依頼した人）がいれば、投稿の前に扱いを確かめる。
    いなければ止まらずに総評に書く。
- 既存のレビュー
  - 親はレビューの前に、PR にすでにあるレビュー（他のレビュアーの指摘と作者の返答）の状況を確かめる。
    依頼した側が渡したものを使い、渡されていなければ PR から読めるときだけ取得する。
  - 既存の指摘と同じ箇所・同じ問題は、`must` でも繰り返さない。
    理由「既存のレビューで指摘済み」で不採用にし、判定にも数えない。
  - 省いた件数を総評に短く書く。
  - 既存の指摘は担当に渡さず、集約の記録の `existing_reviews` に件数を残す。
- PR の本文や依頼文で示された文書（Git の外に書いた設計書など）
  - 親がタイトル・説明・差分から、レビューの対象か根拠かを分ける。
  - どちらも親が全文を取得して、作業領域の外に写しを置く。
  - 対象にした文書は、主対象の種類の判断と担当の対象に含める（差分の外でも範囲から外さない）。
  - 取得できない文書は「レビューの範囲」に書く。
    主対象にした文書が読めなければ、レビューを完了できなかったものとして扱う。
  - 分けた結果は集約の記録の `linked_docs` に残す。

コード: `apps/daemon/default-context/skills/review/review-dispatch/SKILL.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/pr-review.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/linked-docs.md`、`apps/daemon/default-context/skills/git/references/pr-review-posting.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/verification-run.md`、`apps/daemon/default-context/skills/review/review-execution/references/X-2.md`、`apps/daemon/default-context/agents/codex/config.toml`、`apps/daemon/default-context/skills/review/review-dispatch/references/screen-capture.md`、`apps/daemon/default-context/skills/review/review-execution/references/C-15.md`、`apps/daemon/default-context/skills/review/review-execution/references/C-16.md`、`apps/daemon/default-context/skills/review/review-execution/references/C-17.md`、`apps/daemon/default-context/skills/review/review-execution/SKILL.md`、`apps/daemon/src/prompts.ts`（`buildPrompt`）、`apps/daemon/default-context/skills/review/review-execution/references/D-10.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/self-review.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/viewpoints.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/repo-guidance.md`、`apps/daemon/default-context/skills/review/review-dispatch/references/aggregation.md`、`apps/daemon/default-context/skills/review/review-execution/references/X-3.md`、`apps/daemon/default-context/skills/review/review-execution/references/R.md`、`apps/daemon/default-context/skills/review/review-execution/references/C-5.md`、`apps/daemon/src/default-skills.test.ts`、`apps/daemon/src/review-eval.test.ts`、`apps/daemon/src/testing/review-eval/index.ts`（`s18Workspace`・`runAgent`）

## 既定の文章用スキル

既定のコンテキストには、人が読む文章（PR の本文、レビューのコメント、Issue・PR へのコメント、要求要件・設計、調査の結果、報告）の書き方を決める `writing` がある。
従う順は、依頼した人の指示、対象のリポジトリの文章の決まり（AGENTS.md・CONTRIBUTING・docs の方針など）、このスキルの順。
日本語では「。」の後で改行し、英語ではピリオドの後で改行しない。
改行の書き方は、書き出し先（GitHub のコメント、リポジトリの Markdown のファイル、Confluence のエディタとストレージ形式、チャット）ごとに決める。
リポジトリの Markdown のファイルでは、表示でも改行されるよう、「。」で終わる行の行末に `\` を置く（段落の最後の文には付けない。リポジトリが別の書き方に決めていれば、それに従う）。
コードブロック・表のセル・コミットメッセージの1行目など、改行で表示が崩れる所では改行しない。
英語の語を訳語に1対1で置き換えず（entry point を「入口」にしない）、カタカナで定着した語（エンドポイントなど）はそのまま使い、言い回しも日本語で一般的なものにする（`references/wording.md`）。
人に確認・判断を求める項目には、確認しないで進めた場合の具体的な懸念を1〜2文で添える。
要求要件・設計は、スコープ（対象と対象外）を最初に書く。
既定の `git`・`review-dispatch`・`review-execution` は、文章を書く所でこのスキルを参照する。
情報を絞ることを、決まりの最初に置く。
読む人は前提（暗黙知）を持っているとして、判断と作業に要ることだけを書き、最初は最小限にして、読む人が求めた所だけを足す。
要求要件・設計・文書・調査の結果の工程の指示も、このスキルがあれば従うよう求める（[タスクと工程](tasks-and-steps.md)）。
既定の規則（`rules.md`。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡る）でも、人が読む文章は必ずこのスキルを使って書くよう求める。
依頼した人の指示と対象のリポジトリの文章の決まりは、このスキルより優先する。
同じ規則は、人に確認・判断を求めるとき（確認したいこと、人が確かめること、質問、変更の申し出など）に、確認しないで進めた場合の具体的な懸念を項目ごとに1〜2文で添えることも求める（PBI-340）。
同じ規則は、人が読む文章に、sacty の作業領域の内部のパス（`/sacty-input` など、コンテナの内部のパス）を書かないことも求める。人は辿れないので、リポジトリのパス・タスクの依頼の文言・人の指摘の ID で示させる（PBI-301 A7）。

関係する ADR: [既定のコンテキストに文章を書くためのスキルを同梱し、「。」の後の改行は日本語だけにする](../adr/20261015-0844-default-writing-skill.md)、[人間が読む成果物の初版を最小限にし、詳しさは人間の差し戻しで足す](../adr/20261025-0222-superseded-minimal-first-drafts.md)、[要求要件・設計はスコープを最初に置き、人への確認には確認しない場合の懸念を添える](../adr/20261113-0708-scope-first-and-concerns-in-questions.md)

コード: `apps/daemon/default-context/rules.md`、`apps/daemon/default-context/skills/writing/SKILL.md`、`apps/daemon/default-context/skills/writing/references/layout.md`、`apps/daemon/default-context/skills/writing/references/sentences.md`、`apps/daemon/default-context/skills/writing/references/wording.md`

## 既定の要求要件用スキル

既定のコンテキストには、要求要件の受け入れ条件を EARS（Easy Approach to Requirements Syntax）の文型で書く `ears-requirements` がある（PBI-122）。
文型は、常時・イベント駆動・状態駆動・望まない振る舞い・オプションと、その組み合わせ（日本語と英語）。
1文に1つの要求を書き、ID（`R-1` など）を付け、応答は第三者が合否を決められる形にする。
ID は、直しても付け直さず、消した要求の ID は使い回さない。最初の提出では 1 から欠番なく振り、差し戻しで消した要求は、ID を詰めずに「R-5（削除：理由）」のように行を残す。別の文書を参照する要求には、参照先の中身を1行で併記する。
書き出すときは、文型ごとに見出しを分け、文型ごとの列（常時は ID・システム・応答、イベント駆動は ID・トリガー・システム・応答など）の表に、1行に1つの要求を書く。
従う順は、依頼した人の指示、対象のリポジトリの要求要件の決まり、このスキルの順。

要求要件の工程の指示は、受け入れ条件を EARS の形式で書き、このスキルがあれば従うよう求める（[タスクと工程](tasks-and-steps.md)）。
プロジェクトのコンテキストでスキルを消していても形式がわかるよう、文型・表の列・ID・異常系の書き方は指示にも書く。
異常系は、今回の変更で新しく起こりうるものだけを書かせる。
依頼に無い要求と、既存の仕組みが保証していて今回の変更で変わらない振る舞いは、要求にしない。
要求の数は最小限にし、足りない要求は読む人が求めたときに足す。
受け入れの確かめ方を書くときは、自動のテストで確かめること（実機や特定の環境の振る舞いは、合成の入力・イベントで模擬する）と、人が確かめること（作業領域では確かめられない実機・特定の OS・入力方式・外部のサービス・目視など。最終承認で人が確かめる項目になる）に分けて書くよう指示する（`acceptanceCheckLines`。PBI-155）。
人が確かめることには、項目ごとに、確かめないまま進めた場合の具体的な懸念（何が・誰に・どう困るか）を1文で添えさせる（PBI-340）。
対象のリポジトリのエージェント向けの指示の文書（スキルの SKILL.md と references・AGENTS.md・CLAUDE.md・規則・プロンプトの文など。`AGENT_INSTRUCTIONS`）を書く・直すタスクでは、要求をエージェントの振る舞いではなく文書に何が書かれているべきかで書かせ、受け入れの確かめ方を、自動のテストではなく差分で文書の中身を確かめることとして書かせる（[タスクと工程](tasks-and-steps.md#実装の検証)）。
既定のスキルは、あらゆる言語・分野のリポジトリと sacty の外の使い方に渡るので、sacty に限った書き方をしない。

関係する ADR: [要求要件の受け入れ条件を EARS 形式で書かせ、既定のスキル ears-requirements を同梱する](../adr/20261017-0130-ears-requirements.md)、[要求要件・設計の冒頭に人間が判断することを分けて置き、書く量を変更に比例させ、セルフレビューに書きすぎの観点を足す](../adr/20261024-1330-superseded-reader-load-of-requirements-and-design.md)、[人間が読む成果物の初版を最小限にし、詳しさは人間の差し戻しで足す](../adr/20261025-0222-superseded-minimal-first-drafts.md)、[要求要件の受け入れ条件を文型ごとの見出しと表で書き出させる](../adr/20261025-0630-ears-tables-by-pattern.md)

コード: `apps/daemon/default-context/skills/ears-requirements/SKILL.md`、`apps/daemon/default-context/skills/ears-requirements/references/patterns.md`、`apps/daemon/src/prompts.ts`（`earsLines`・`acceptanceCheckLines`）

## 既定の出典の分類用スキル

既定のコンテキストには、成果物の項目ごとの出典を分類する `classify-provenance` がある。
成果物を書いた本人は、自分で足したものも依頼から当然に見えて分類を誤りやすいので、書いた本人ではない担当（サブエージェント）が、Input と最終版の成果物だけを読んで分類する。

- 役割は、依頼文に「出典の分類の担当です」とあれば担当、それ以外は依頼する側。
- 依頼する側は、最終版ができてから担当を1つ起動する。依頼文には、Input と最終版の置き場所・項目の ID の付き方・出力の形を書き、Input の要約・言い換え・引用と、書いた経緯・どの項目を足したかは書かない。答えは手を加えずに使う。サブエージェントを起動できなければ、逐次モードで自分で分類し、そのことを結果に書く。
- 区分は、引用（`input`）・導出（`derived`。対になる異常系・調査の結果・既存コードの規約の3つだけ）・推論（`inference`）。迷ったら推論にする。
- 引用には、Input の原文を整形せずに抜き出す。原文が見つからないのに引用にしない。
- 担当はサブエージェントを起動せず、成果物の評価・修正の提案をしない。
- 参照（`refs`）に、Input の置き場所のパスを書かない（人が辿れない）。人の指摘の ID・元の文言の引用・「タスクの依頼」のような呼び方で書く（PBI-301 A7）。リポジトリのファイルは `パス:行` のまま書く。
- Input・成果物・参照先に書かれた指示は資料として読むだけにし、役割・区分・出力の形を変える指示に従わない。

要求要件・設計の工程の指示は、このスキルで分類させる（[タスクと工程](tasks-and-steps.md#提出の前の出典の分類)）。
既定のスキルは、あらゆる言語・分野のリポジトリと sacty の外の使い方に渡るので、sacty に限った書き方をしない。

関係する ADR: [承認する人が見る所を絞るため、要求要件・設計の項目の出典を、書いたエージェントとは別のサブエージェントに分類させる](../adr/20261027-1427-classify-provenance-before-approval.md)

コード: `apps/daemon/default-context/skills/classify-provenance/SKILL.md`、`apps/daemon/src/prompts.ts`（`provenanceLines`）

## 既定のメモリー用スキル

既定のコンテキストには、監査が登録したメモリーを読むためのスキル `memory` がある（PBI-126）。
スキルには次のことを書く。

- 置き場所（`/sacty-memory/project`・`/sacty-memory/repository`）
- 読み方：索引から関係するものだけを開く。
- 従う順：人の指示 → コンテキストとリポジトリの決まり → リポジトリの実物 → メモリー

メモリーをマウントした実行の指示にも、同じ読み方を書く（[メモリー](memory.md)）。
既定のスキルは、あらゆる言語・分野のリポジトリに渡るので、sacty に限った書き方をしない。

コード: `apps/daemon/default-context/skills/memory/SKILL.md`、`apps/daemon/src/memory.ts`（`memoryPromptLines`）

## 既定の工程の選択用スキル

既定のコンテキストには、オーケストレーターが工程の組み合わせを選び、決められた形の JSON で答えるための `plan-steps` がある（PBI-146）。
スキルには次のことを書く。

- 候補の比べ方：目的・成果物・変更対象・規模の順。
  無条件の既定や受け皿にしない。
- 理由の書き方
- 答えの JSON の決まり：見出しと項目の名前はそのまま、形の例の注釈を写さない、要らない項目はキーごと省く。
- 答えの検査（`references/json-check.md`）：答えは出す前にファイルに書き、`jq`（無ければ `python3`・`node`）で構文と形（見出しと必須の項目）を検査する。
  通るまで直してから、本文の最後に 1 回だけ出す。

オーケストレーターの指示は、このスキルに従うよう求める。
プロジェクトのコンテキストでスキルを消していても最低限がわかるよう、検査して通るまで直すこと・1 回だけ出すことを指示にも書く（[タスクと工程](tasks-and-steps.md#オーケストレーター)）。
sacty の工程の選び方を扱うスキルなので sacty の名前を書いてよいが、特定の言語のツールチェーンには寄せない。

関係する ADR: [オーケストレーターにもコンテキストを渡し、工程の選択を既定のスキル plan-steps にして答えの JSON を検査させる](../adr/20261019-1512-orchestrator-plan-steps-skill.md)

コード: `apps/daemon/default-context/skills/plan-steps/SKILL.md`、`apps/daemon/default-context/skills/plan-steps/references/json-check.md`、`apps/daemon/src/prompts.ts`（`planAnswerLines`・`PLAN_SKILL`）

## 既定の図用スキル

既定のコンテキストには、draw.io の図（`.drawio`。PNG・SVG・PDF への書き出しを含む）を作る `drawio` がある。

- 中身は draw.io の公式のスキル（`jgraph/drawio-mcp` の `plugins/claude-code/skills/drawio/SKILL.md`。Codex 用も同じ中身。Apache-2.0）。
  手を加えずに、ライセンス（`LICENSE`）とともに置く。
- 取り込んだ版は `jgraph/drawio-mcp` の `307725c331847c15bf5ddeef64a9c8434a30fadf` で、SKILL.md の SHA-256 をテストで確かめる。
- スキルは、図を Mermaid か draw.io の XML で書き、Mermaid の変換・ELK のレイアウト・書き出しにイメージの `drawio`（[エージェントの実行](agent-execution.md#イメージ)）を使う。
  `drawio` が無ければ、XML で `.drawio` を作る。
- Mermaid・XML の詳しい書き方は、スキルが実行のときに `raw.githubusercontent.com` から取得する（届かなければ、SKILL.md の内容だけで書く）。

関係する ADR: [エージェントのイメージに作業用の CLI と draw.io の CLI を入れ、draw.io の公式のスキルを既定のスキルにする](../adr/20261022-0115-agent-image-tools-and-drawio.md)

コード: `apps/daemon/default-context/skills/drawio/SKILL.md`、`apps/daemon/default-context/skills/drawio/LICENSE`、`apps/daemon/src/default-skills.test.ts`

## コンテキストリポジトリのファイル

読むのは `sacty-context.yaml`・`mcp.yaml`・`platforms.yaml`・`images.yaml`・`rules.md`・`rules/`・`skills/`・`agents/` だけ（`README.md` は読まない）。

- これらの中に通常のファイル・ディレクトリでないもの（シンボリックリンクなど）があれば止める（`context.notPlainFile`）。
- YAML が無ければ既定値を使う。
- 読めなければ `context.fileUnreadable`、形が違えば `context.fileInvalid`（どの層のどのファイルのどの項目か）で止める。

| ファイル | 中身 |
| --- | --- |
| `rules.md` か `rules/*.md` | 規則。`rules.md` があればそれだけ、無ければ `rules/` の直下の `*.md` を名前の順に連結する。層ごとに `<!-- sacty context: <層> -->` を付けて上位から連結する |
| `skills/` | `SKILL.md` のあるディレクトリが1つのスキル（名前はディレクトリ名）。無いディレクトリはグループとして中を探す。同じ層で名前が重なれば先のものを使い警告する |
| `mcp.yaml` | `servers.<名前>`（`^[A-Za-z0-9_-]+$`）。コマンド型（`command`・`args`・`env`・`via_gateway`（既定 `true`））か URL 型（`url`・`headers`・`via_gateway`（既定 `true`））。共通で `startup_timeout_sec`（1〜3600）・`tool_timeout_sec`（1〜86400）。値は文字列か `{ secret, prefix }`。文字列に `${` は書けない |
| `platforms.yaml` | `platforms.<名前>`。項目は `gateway.platforms` と同じ（[ゲートウェイ](gateway.md)） |
| `images.yaml` | `images.<名前>`。項目と検査は `config.yaml` の `images` と同じ（[設定](configuration.md#イメージの設定の検査)）。ただし `image` と、知らない項目は書けない。デーモンが作る（[デーモンの起動と終了](daemon-lifecycle.md#コンテキストのイメージの作成)） |
| `sacty-context.yaml` | `extends`、`locked`・`remove`（それぞれ `skills`・`mcp`・`platforms`・`images` の名前の一覧） |
| `agents/codex/config.toml`・`agents/claude/settings.json` | エージェントの設定。`agents/codex/`・`agents/claude/` の下のほかのファイルはパスごとに写す |

コード: `apps/daemon/src/context.ts`（`CONTEXT_ENTRIES`・`assertPlainEntries`・`readYaml`・`layerRules`・`layerSkills`・`McpFile`・`McpServer`・`McpValue`・`PlatformsFile`・`ImagesFile`・`ContextManifest`・`AGENT_SETTINGS_FILES`・`contextImages`）

## 合成の規則

合成の流れは次のとおり（詳しい規則は下の箇条書き）。

![コンテキストの合成の流れ](images/context-merge.svg)

- スキル・MCP・PF は、名前ごとに、層を上位から順に処理する。
  1つの層では、次の順に処理する。
  1. その層の `remove` を処理する。
     上位が `locked` なら残して、警告 `context.lockedRemove` を出す。
  2. その層の項目を入れる。
     同じ名前は下位が上書きする。
     `locked` の名前なら上位のものを残して、警告 `context.lockedOverride` を出す。
  3. その層の `locked` を登録する。
- エージェントの設定は、表はキーごとに重ね、それ以外（配列を含む）は下位の値で置き換える。
  Claude の `permissions.allow`・`deny`・`ask` だけは重複を除いて合わせる。
- sacty が決める項目は使わずに警告する（`context.reservedSetting`）。
  - Codex の `mcp_servers`・`model_provider`・`model_providers`・`approval_policy`・`sandbox_mode`・`profile` など
  - Claude の `apiKeyHelper` など
  - Claude の `env` の認証・接続先・設定の場所の変数と `SACTY_` で始まる名前
- `agents/` の下の `auth.json`・`AGENTS.md`・`CLAUDE.md`・`.credentials.json`・`.claude.json`・`mcp.json`・`skills` も写さずに警告する。
- 段階のサブエージェントの定義（`agents/claude/agents/<段階>.md`・`agents/codex/agents/<段階>.toml`。[設定](configuration.md#エージェントの既定と上書き)の `claude_<段階>`・`codex_<段階>`）は sacty が作る。
  - 層にあれば、その段階を置くかどうかによらず写さずに警告する（`context.reservedTierFile`）。
    残すと、スキルが段階の名前で起動したときに層の定義が使われるためである。
  - Codex はファイルの中の `name` をロールの名前にする。
    そのため、`agents/codex/agents/*.toml` の `name` が段階のものも、ファイル名によらず写さずに警告する（`codexRoleName`）。
    - `name` は前後の空白を除いて比べ、空なら名前とみなさない。
    - 読むのは層のエージェントの設定のディレクトリの中の、リンクでない通常のファイル（256KB まで）だけ。
      `config_file` が外・絶対パス・通常でないファイルを指すときは、読まずに宣言を残す。
      読めないファイルはそのまま写す。
  - 次のものも、sacty が決める項目として使わずに警告する（`context.reservedSetting`。`agents` のほかの項目は残す）。
    - Codex の `config.toml` の `agents.<段階>`（カスタムエージェントの宣言。自動で探す `agents/<段階>.toml` より先に登録される）
    - `config_file` が指す定義の `name` が段階の `agents.<名前>`
- ホストの MCP サーバー（`gateway.mcp_servers`）を足す。
  層の MCP と同じ名前なら、ホストのものを使い警告する（`context.hostMcpOverride`）。
- PF は、ホストの `gateway.platforms` と合わせる。
  同じ名前ならホストのものを使い警告する（`context.hostPlatform`）。
- 警告は工程を止めない。
  合成の結果（層・警告・PF の要約）は、工程の実行ごとに `ContextResolved` に記録する。
- 取得の失敗と形の誤りは、実行の失敗にして一時停止する。

コード: `apps/daemon/src/context.ts`（`composeContext`・`mergeNamed`・`mergeSettings`・`RESERVED_SETTINGS`・`RESERVED_FILES`・`routeMcp`）、`apps/daemon/src/platforms.ts`（`mergePlatforms`）、`apps/daemon/src/service.ts`（`runContext`）

## 実行のときに置くファイル

設定の場所（Claude Code は `/tmp/sacty-claude-config`、Codex は `/.codex`）に、層のエージェントのファイル → スキル（`skills/<名前>/…`）→ sacty が作るファイルの順に置く（同じパスは後のものが上書き）。
層のエージェントのファイルとスキルのディレクトリの `.git`（サブモジュールの、git の管理の情報を指すファイル）は置かない（`apps/daemon/src/context.ts` の `filesUnder`・`layerAgentFiles`）。

| runtime | sacty が作るファイル |
| --- | --- |
| Claude Code | `CLAUDE.md`（規則）、`settings.json`（合成した設定）、`mcp.json`（`{ "mcpServers": … }`。コマンド型は `command`・`args`・`env`、URL 型は `type: "http"`・`url`・`headers`）、`agents/<段階>.md`（段階のサブエージェントの定義。frontmatter の `name`・`description`・`model`・`effort`） |
| Codex | `AGENTS.md`（規則と、スキルの一覧 `- <名前>：<description>（<場所>）`）、`config.toml`（合成した設定と `[mcp_servers."<名前>"]`。URL 型は `url`・`http_headers`・`env_http_headers`）、`agents/<段階>.toml`（段階のサブエージェントの定義。`name`・`description`・`developer_instructions`・`model`・`model_reasoning_effort`） |

### 段階のサブエージェントの定義

段階のサブエージェントの定義（PBI-119）は、次の条件に合う段階を、接頭辞を外した名前で置く（`selectTiers`・`tierFiles`）。

- 使えるエージェントの `claude_<段階>`・`codex_<段階>` である。
  使えるエージェントとは、`config/agents.yaml` の既定に `config.yaml` の `agents` を重ね、接続先と単価があるもの（[設定](configuration.md#エージェントの既定と上書き)）。
- 工程のエージェントと同じ runtime である。
- 認証・接続先（`auth`・`endpoint`・`via_gateway`）が同じである。

違うものは置かず、`agents.tierConnectionDiffers` を注意に残す（接続先は runtime ごとの `providers` から作るので、同じ runtime の段階はいつも同じになる）。

- stub の工程には置かない。
- `reasoning_effort` の無い段階（既定の `claude_lite` など）は、それを書かない定義（ツールの既定）になる。
- 置いた段階（段階・エージェントの名前・モデル・リーズニングエフォート）は `ContextResolved` の `tiers` に記録する。
- プレビューにも同じファイルを出す。
  プレビューの親は、その runtime の `default_agent`、無ければ `step_agents`・`audit_agent` のうち最初のもの。
- `ContextResolved` は、コンテキストを渡すたびに、その実行の `runId` で記録する（`contextResolved`）。
  工程の実行だけでなく、情報収集・オーケストレーター（PBI-146）・マージの後の監視・外部作業・書き出しの実行でも記録する。
- 段階を置いた実行の費用は推定（`estimated`）として記録する。
  担当が親と違うモデルで動きうるためである。費用は、CLI が報告した額か、モデルごとの使用量をそのモデルの単価で換算した額にする（[エージェントの実行](agent-execution.md#出力の扱い)）。

### MCP の渡し方

MCP サーバーの動く場所と、エージェントに渡すものは、次のように決まる。

![MCP サーバーの置き場所の決まり方](images/context-mcp.svg)

- MCP の秘密情報は、ファイルには `SACTY_MCP_SECRET_<番号>` の環境変数として書き、値はコンテナの環境変数で渡す（ホストで取り出す）。
- 層の `mcp.yaml`・`platforms.yaml` の秘密情報は、ほかの秘密情報とまとめて取り出してある（[秘密情報](secrets.md#起動のときのまとめての取り出し)）。
  取り出すのは、デーモンの起動のとき・取り出し直したとき・プロジェクトを保存したとき。
  取り出していないもの（その後に層に足されたものなど）は、使うときに取り出す。
- 層の MCP サーバーは、`via_gateway` が `true`（既定）なら、ゲートウェイ経由に置き換える。
  エージェントには `http://host.docker.internal:<ポート>/ctx-mcp/<名前>` と、実行ごとのトークンの `Authorization` だけを渡す（`routeMcp`）。
  - URL 型：元の URL とヘッダーはゲートウェイが持つ（ヘッダーの秘密情報はホストで取り出す）。
  - コマンド型：ゲートウェイがホストで起動する（下の「ホストで起動するコマンド型の MCP サーバー」）。
    `env` の秘密情報はホストで起動するときに取り出し、コンテナには渡さない。
  - `via_gateway: false` なら、コンテナの中で起動する（URL 型はコンテナから直接つなぐ）。
    秘密情報の値は環境変数でコンテナに渡す。
  - ゲートウェイが無いときは、どちらもコンテナの中で起動する・直接つなぐ。
- ホストの MCP サーバー（`gateway.mcp_servers`）は `/mcp/<名前>` として渡す（[ゲートウェイ](gateway.md)）。
- MCP の時間切れ
  - Codex：`config.toml` に同じ名前で書く。
  - Claude Code：`tool_timeout_sec` をサーバーごとの `timeout`（ミリ秒）にする。
    `startup_timeout_sec` をどれかに書いたときだけ、全体の環境変数 `MCP_TIMEOUT` を、各サーバーの値（書いていないサーバーは 30 秒）の最大にする。
  - どれかがその実行の上限（`config.yaml` の `run_timeout` の役割の上限。既定 30 分。PBI-150）以上なら警告する（`context.mcpTimeoutOverRun`）。

コード: `apps/daemon/src/context.ts`（`planContext`・`codexServer`・`timeoutWarnings`・`routeMcp`・`McpServer`・`CLAUDE_MCP_CONFIG`・`CLAUDE_MCP_STARTUP_DEFAULT_SEC`・`GATEWAY_TOKEN_SECRET`）、`apps/daemon/src/service.ts`（`contextContainerDir`・`mcpRouting`）

## ホストで起動するコマンド型の MCP サーバー

`via_gateway`（既定 `true`）のコマンド型の MCP サーバーは、ゲートウェイがホストで起動する。
起動・準備・再起動・中継・プロセスの記録は、ホストの MCP サーバー（[ゲートウェイ](gateway.md)）と同じ仕組みを使う。
コンテキストリポジトリを編集できる人は、ホストでコマンドを動かせる。

- 名前の分離
  - ゲートウェイの中の名前（`ctx-<SHA-256 の先頭24桁>`）は、プロジェクトと中身（`mcp.yaml` の名前・`command`・`args`・`env`・時間切れ・層のリポジトリ・ref・commit）から作る。
  - 実行のトークンごとに、その実行のプロジェクトの名前にだけ結びつける。
    ほかのプロジェクトの実行からは、名前を知っていても使えない（404）。
  - 同じ名前で中身が違っても混ざらない。
- 使い回し：同じプロジェクトで同じ中身なら、実行をまたいで同じプロセスを使う。
  中身（層の commit を含む）が変われば、新しい名前で起動する。
- 作業ディレクトリ
  - そのサーバーを書いた層のディレクトリ（`path` があればリポジトリの中のそのディレクトリ）の写し（`SACTY_HOME/context-mcp/layers/<プロジェクトと層の識別>-<乱数>`。`.git` は写さない）。
    層の識別は、`repo`・`ref`・`path`・`commit` から作る。
  - 取得した層は実行の後に消えるので、確保のときに写し、使うものが無くなったら消す。
  - 相対パスのコマンドは作業ディレクトリから、ほかは `PATH` から探す。
    無ければ起動する前に理由（`context.mcpHostCommandMissing`）にする。
- 確保と解放
  - 実行の前に、その実行が使うサーバーをまとめて確保する。
    すべて用意できてから確定する。
    途中で失敗したら、その確保で写した層を消して、持っている状態を変えない。
    用意したコンテキストも消す。
  - 準備は `max(120 秒, startup_timeout_sec)` まで待つ（`CONTEXT_MCP_READY_SEC`）。
    準備ができなければ、どのサーバーか（`mcp.yaml` の名前と層）をコンテキストの警告に残して実行する（書き出しでは、その接続先への書き出しを止める）。
  - 実行が終わったら解放する。
- 止める
  - 使っている実行が無くなったものは、同じプロジェクト・同じ名前で新しい中身が使われたら（古くなったら）すぐに止める。
    そうでなければ、最後に使ってから30分で止める（60秒ごとに確かめる）。
  - 止める・写しを消す途中の失敗は、確保・解放の失敗にせず、ログに残して後でやり直す。
  - デーモンの終了ですべて止めて写しを消す。
    デーモンの起動のときに前回の写し（`context-mcp/layers`）を消す（残ったプロセスは、ホストの MCP サーバーと同じ片付けで止める）。
- 理由（画面・作業履歴・エージェントへの 503）には、`mcp.yaml` の名前・層・プロジェクトの名前を出し、ゲートウェイの中の名前は出さない。
  - 項目は `context.mcpHostUnavailable`・`context.mcpHostReadyTimeout`・`context.mcpHostCommandMissing` の `name`・`from`・`project`。
  - `project` の無い前の記録は、プロジェクトを出さずに表示する。
  - 同じ層・同じ名前のサーバーが複数のプロジェクトにあっても、どれかわかる。
- ログ（起動・準備できない・止める・後片付け）にも、`mcp.yaml` の名前・プロジェクトの名前と ID・層を出し、ゲートウェイの中の名前を添える（[ゲートウェイ](gateway.md)の「ホストの MCP サーバー」）。
- 理由・ログに出す層は、リポジトリの URL に認証情報（`https://<ユーザー>:<トークン>@…`）があれば `***` に伏せる（`shownLayer`）。
- プロジェクトの名前は、確保のときのものを出す。
  ゲートウェイの中の名前はプロジェクトの ID から作るので、名前を変えても起動し直さない。

コード: `apps/daemon/src/context-mcp.ts`（`ContextMcpServers`・`lease`・`prepare`・`sweep`・`copyLayer`・`forceRemove`・`shownLayer`・`CONTEXT_MCP_READY_SEC`）、`apps/daemon/src/context.ts`（`routeMcp`・`HostedContextMcp`）、`apps/daemon/src/host-mcp.ts`（`assertCommand`・`CommandNotFoundError`・`HostMcpContext`・`mcpLogName`）、`apps/daemon/src/service.ts`（`runContext`・`mcpRouting`）、`apps/daemon/src/main.ts`

## 雛形（sacty context init）

`README.md`・`rules.md`・`skills/README.md`・`mcp.yaml`・`platforms.yaml`・`sacty-context.yaml`・`agents/codex/config.toml` を作る。
中身は説明のコメントだけで、既定のコンテキストを変えない。
`README.md` には、段階のサブエージェントの定義は sacty が作るので置いても使わないことを書く。

- 同じパスか `rules` があれば、`--force` が無い限り何も書かずに止まる。
- 途中のディレクトリがディレクトリでなければ `--force` でも止まる。

コード: `apps/daemon/src/context-template.ts`（`CONTEXT_TEMPLATE_FILES`・`initContextRepo`）

## プレビュー

- 窓口
  - `GET /api/projects/:id/context-preview?runtime=`：保存した設定
  - `POST /api/projects/:id/context-preview`（`{ runtime, definition? }`）：編集中の設定
  - `runtime` の既定は `claude-code`。
  - 実行と同じ合成を行うが、ファイルは書かず、作業履歴にも残さない。
  - 取得・設定の誤りは 200 で `{ error }` を返す。
- 結果に入るもの
  - 層
  - 置くファイル（1ファイル 256KB、合計 8MB まで。バイナリは中身を出さない）
  - MCP（どこにつなぐか：`direct`・`gateway`・`host`・`hostCommand`）。
    `hostCommand` はホストで起動するコマンド型で、コマンド・引数・`env` の参照・どの層の写しで動くかを出す。
  - スキル・規則・効果（`locked`・`remove`）
  - 秘密情報の参照（参照の名前だけを出す）
  - 環境変数・使える PF の要約・警告
- `sacty context preview <プロジェクト>`：`SACTY_HOME/daemon.json` の接続先に問い合わせる。
  - プロジェクトは ID か名前。
  - オプションは `--runtime`（`claude-code`｜`codex`）・`--json`（API の結果のまま）・`--no-content`（ファイルの中身を省く）。
  - 誤りなら終了コード 1。
- プロジェクトを保存するときも、コンテキストを指定していれば同じ合成を試し、誤りを返す（保存はする）。

コード: `apps/daemon/src/server.ts`（`PreviewRequest`）、`apps/daemon/src/service.ts`（`projectContextPreview`・`checkProjectContext`・`ContextPreviewView`）、`apps/daemon/src/context.ts`（`previewContext`・`ContextPreview`・`PREVIEW_FILE_MAX_BYTES`・`PREVIEW_TOTAL_MAX_BYTES`）、`packages/cli/src/context-preview.ts`（`fetchContextPreview`・`previewOutput`）

## ローカルのセッション（sacty launch）

プロジェクトのコンテキストで、ホストの Claude Code・Codex を対話で起動する。
AI の CLI は利用者のログインと設定（設定の場所 `CLAUDE_CONFIG_DIR`・`CODEX_HOME` は変えない）で動き、sacty の AI の定義と認証の秘密情報は使わない。
作業履歴には何も記録しない（`ContextResolved` も記録しない）。

- 窓口（daemon のトークンを持つものだけが呼べる。画面からは呼ばない）
  - `POST /api/projects/:id/local-sessions`（`{ runtime, dir }`）：セッションを作る。`dir` は CLI が作った一時ディレクトリの絶対パス。
    返すのは `{ session: { id, runtime, files, env, mcpServers, warnings } }`。`files` は置くファイル（パス・層・base64 の中身）、`env` は AI の CLI に渡す環境変数（秘密情報とゲートウェイのトークンの値を含む）。
    取得・設定の誤りは 200 で `{ error }` を返す。プロジェクトが無ければ 404。
  - `DELETE /api/local-sessions/:id`：セッションを終える。無ければ 404。
- 合成
  - プレビュー・実行と同じ組み立て（`prepareContext`）で作る。違うのは次だけ。
    - ゲートウェイの起点はホストから見たもの（`http://127.0.0.1:<ポート>`。`hostOrigin`）。
    - 実行の上限が無いので、MCP の時間切れの警告（`context.mcpTimeoutOverRun`）は出さない。
    - 設定の場所は `dir`（Codex の `AGENTS.md` のスキルの一覧の場所は、`dir` の絶対パスになる）。
  - 段階のサブエージェントは、プレビューと同じ親（その runtime の `default_agent` など）で選ぶ。
    親の認証が `bedrock`・`provider` のときは、接続先ごとのモデルの名前が手元のログインで使えないことがあるので置かず、`local.tiersSkipped` を注意に入れる。
  - ホストで起動するコマンド型の MCP サーバーは、実行と同じく確保して準備を待ち、ホストの MCP サーバーの準備も待つ（準備ができないものは注意にする）。
  - MCP（ゲートウェイ経由のもの）・外部 PF のどれかがあれば、ゲートウェイにこのセッション用の実行を登録し、そのトークンを `env` に入れる（ホストの MCP の認証のヘッダー・`SACTY_PF_URL`）。AI の呼び出しと GitHub の読み取りの中継は登録しない。
  - 外部 PF があれば、使い方の案内（`platformPromptLines`）を規則（`CLAUDE.md`・`AGENTS.md`）の後ろに足す。
    ゲートウェイを使えないときは、外部 PF を渡さず、`local.platformsUnavailable` を注意に入れる。
  - `via_gateway: false` の MCP サーバーの秘密情報は、取り出した値を `env` に入れる。
  - 取得した層は、置くファイルの中身を読んだら消す。
  - セッションを終えると、ゲートウェイの登録を閉じ、ホストで起動したコマンド型の MCP サーバーを手放す。終えずに残ったセッションは、デーモンが止まるまで残る。
- `sacty launch <プロジェクト> [--runtime claude-code|codex] [--cwd <ディレクトリ>] [-- <引数>...]`
  - `--` で分けるのは `launch` のときだけ（ほかのコマンドの引数は分けない）。
  - `SACTY_HOME/daemon.json` の接続先に問い合わせる。プロジェクトは ID か名前。`--cwd` の既定は今のディレクトリ。
  - 一時ディレクトリ（`sacty-launch-*`。権限 0700、ファイルは 0600）を作り、セッションを作ってファイルを置き、AI の CLI を端末の標準入出力と利用者の環境変数（`env` を上に重ねる）で起動する。
    `--` の後の引数は、sacty が組み立てた引数の後に足す。
  - 起動している間、Ctrl+C（SIGINT）では止まらず、SIGTERM・SIGHUP は AI の CLI に渡す。AI の CLI が終わったら（失敗でも）、セッションを終えて一時ディレクトリを消し、その終了コードで終わる。
  - 注意（`warnings`）と、渡さなかったファイルを表示する。
- Claude Code への渡し方

  | 合成したもの | 渡し方 |
  | --- | --- |
  | `CLAUDE.md` | `--append-system-prompt-file` |
  | `settings.json` | `--settings` |
  | `mcp.json`（無ければ空の `{ "mcpServers": {} }`） | `--mcp-config` と `--strict-mcp-config` |
  | `agents/<名前>.md` | `--agents`（JSON。frontmatter の `name`・`description`・`model` と本文。`effort` は渡さない） |
  | `skills/` | `dir` の `.claude/skills/` に置き、`--add-dir` で `dir` を渡す |

  - 最後に `--permission-mode default` を足す（設定の `permissions.defaultMode` より優先する）。
- Codex への渡し方（すべて `-c`）

  | 合成したもの | 渡し方 |
  | --- | --- |
  | `AGENTS.md` | `developer_instructions`（`CODEX_INSTRUCTIONS_MAX_BYTES` を超えたら起動せずに止める） |
  | `config.toml` の `mcp_servers` | `mcp_servers.<名前>=<インラインの表>` |
  | `config.toml` のほか | 葉のキーごとに `<キー>=<値>`。`approvals_reviewer` は渡さない。`agents.<名前>.config_file` は `dir` の絶対パスにする |
  | `agents/<名前>.toml` | `agents.<名前>.config_file`（`dir` の絶対パス）・`agents.<名前>.description` |
  | `skills/` | `dir` に置く（規則のスキルの一覧から場所を示す） |

  - 利用者の MCP サーバー（`CODEX_HOME`、無ければ `~/.codex` の `config.toml` と、`--cwd` から `.git` のあるディレクトリまでの `.codex/config.toml`）は、すべて `mcp_servers.<名前>.enabled=false` にする。
    Codex の `-c` は表を置き換えずに重ね、キーを消すこともできない。そのため、利用者のものと同じ名前のコンテキストの MCP サーバーは、同じ名前のままだと利用者の設定と混ざる（コマンド型と URL 型が混ざると、Codex は「url is not supported for stdio」で起動しない）。
    同じ名前のものは `<名前>-sacty`（それも使われていれば `<名前>-sacty-2`・`-3`…）で渡し、名前を変えたことを表示する（`renamed`）。
  - `.` を含む・空のキーは渡せないので止める。
  - 最後に `--sandbox workspace-write` と `--ask-for-approval on-request` を足す。
    `--` の後の引数に `--sandbox`（`-s`）・`--ask-for-approval`（`-a`）があれば、sacty の同じ引数は足さない（Codex は同じ引数を2回渡すと起動しない）。
- どちらも、上のほかのファイル（Claude Code の `commands/`、Codex の `rules/` など）は渡さず、既定のコンテキスト（`sacty-default`）のもののほかは、渡さなかったことを表示する。

コード: `apps/daemon/src/server.ts`（`LocalSessionRequest`）、`apps/daemon/src/service.ts`（`createLocalSession`・`closeLocalSession`・`LocalSessionView`・`mcpRouting`）、`apps/daemon/src/gateway.ts`（`hostOrigin`・`platformsUrl`）、`apps/daemon/src/local-launch.ts`（`claudeLaunch`・`codexLaunch`・`codexUserMcpServers`・`CODEX_INSTRUCTIONS_MAX_BYTES`）、`packages/cli/src/launch.ts`（`launch`・`splitLaunchArgs`・`writeLaunchFiles`）
