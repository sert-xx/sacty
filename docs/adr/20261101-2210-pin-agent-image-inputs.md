# 既定のイメージに入れるもの（元のイメージ・エージェントの CLI の依存・検査の道具）を、このリポジトリに固定した値で確かめる

- 日時: 2026-11-01 22:10 UTC
- ステータス: 採用
- 関係する PR・タスク: #273
- 置き換え元: [セキュリティチェックとセキュリティ対応を、既存の工程の組み合わせとして足し、対応の差分を修正の範囲と照らして最小限に保つ](20261026-1520-superseded-security-check-and-fix-plans.md)（検査の道具のハッシュの確かめ方）
- 置き換え先: なし

## 背景

sacty のセキュリティチェックで、既定のイメージ（`packages/cli/docker/Dockerfile`）について、次の3つの指摘があった（いずれも low）。

- 元のイメージ（`node:26-bookworm-slim`）をタグだけで指定していて、タグが別のイメージに付け替わると、同じ sacty の版でも違うイメージから作られる。
- エージェントの CLI を `npm install -g <名前>@<版>` で入れていて、直接の版は固定しているが、推移依存はロックしていない。
- osv-scanner・gitleaks を、バイナリとハッシュのファイルを同じ GitHub のリリースから取って確かめていて、リリースそのものがすり替わると防げない。

元のイメージは `image_build.base_image` で、npm のレジストリは `image_build.npm_registry` で変えられ、プライベートのレジストリで作る利用者がいる（PBI-33）。固定のしかたは、それを壊さない必要があった。

## 決定

- 元のイメージの既定（`BASE_IMAGE`・`NODE_IMAGE`）は、タグに加えて、マルチアーキのインデックスのダイジェストで固定する（`node:26-bookworm-slim@sha256:…`）。`image_build.base_image` などで変える仕組みはそのまま。
- エージェントの CLI は、`packages/cli/docker/agent-cli` の `package.json`・`package-lock.json` を `npm ci` で入れる。lockfile には取得元の URL（`resolved`）を書かない（`npm install --package-lock-only --omit-lockfile-registry-resolved` で作る）。
- osv-scanner・gitleaks は、版・アーキテクチャごとの sha256 を `install-security-tools.sh` に固定して確かめる（draw.io と同じ）。取得できないときは警告して続け、合わないときは止める方針は変えない。

## 理由

- ダイジェストはマルチアーキのインデックスのものにする。アーキテクチャごとのマニフェストのダイジェストでは、ほかのアーキテクチャで作れなくなる。
- lockfile に `resolved` を書くと、公開レジストリの URL が残る。npm は既定（`replace-registry-host=npmjs`）で、その URL を設定したレジストリに置き換える（npm 10.8.2・11.19.1 の実装で、レジストリの URL のパスも付けることを確かめた）が、置き換えは npm の設定と版ごとの実装に頼ることになる。`resolved` を書かなければ、設定したレジストリのメタデータにある取得元から取り、lockfile の `integrity` で中身を確かめるので、置き換えに頼らない（パスのあるプライベートのレジストリを真似た中継で、すべての取得がそのレジストリに認証付きで届くことを確かめた）。
- 検査の道具のハッシュを固定しなかった前の決定の理由は、決めた時点でリリースの添付物を取得して確かめられなかったことだった。今回は、GitHub がリリースの添付物に記録している sha256 を固定し、amd64・arm64 のイメージを作って、取得した実物がその値と合うことを確かめた。
- 比べた案：
  - CLI を `npm install -g` のまま、`npm-shrinkwrap.json` を持つ自前のパッケージを作る。作り方が増えるわりに、`npm ci` と違いが無い。
  - lockfile に `resolved` を書き、既定の置き換えに任せる。今の npm では動くが、置き換えの実装は npm の版で変わってきていて、元のイメージの npm の版は利用者が選ぶ。

## 影響

- 元のイメージのタグを上げる・ダイジェストを更新するときは、`docker buildx imagetools inspect <タグ>` の `Digest` に変える（CONTRIBUTING.md の版上げの手順）。ダイジェストを更新しない限り、元のイメージの OS の更新は入らない。
- エージェントの CLI の版を上げるときは、`agent-cli/package.json` を変えて lockfile を作り直す。`resolved` が無いこと・版がそろっていることは `apps/daemon/src/image.test.ts` で確かめる。
- プライベートのレジストリは、lockfile と同じ版を、公開レジストリと同じ中身（`integrity`）で返す必要がある。中身を作り直すレジストリでは作れない。
- `resolved` が無いので、`npm ci` はパッケージごとにレジストリのメタデータを取る（入れる数が少ないので、時間の差は小さい）。
- 検査の道具の版を上げるときは、版とアーキテクチャごとのハッシュを一緒に変える（`install-security-tools.sh` の先頭のコメント）。
- 仕様は [エージェントの実行](../spec/agent-execution.md)、利用者向けは [イメージ](../user/images.md) に書く。
