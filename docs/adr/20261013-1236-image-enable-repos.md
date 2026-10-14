# イメージの packages を入れるときに、enable_repos に書いた無効の repo を有効にする

- 日時: 2026-10-13 12:36 UTC
- ステータス: 採用
- 関係する PR・タスク: #66、PBI-59
- 置き換え元: なし
- 置き換え先: なし

## 背景

#60 で、言語ごとのイメージに OS のパッケージ（`packages`）を書けるようにした。利用者の Rocky Linux のイメージには、利用者の rpm
リポジトリの repo が設定されていても無効になっていることがあり（`--enablerepo` を付けないと使えない）、そのままでは `packages` を
入れられない。

## 決定

- `images.<名前>.enable_repos`：repo の ID のリスト（既定は空）。`packages` を入れるときに、そのリポジトリを有効にする。
  - ID は `^[A-Za-z0-9][A-Za-z0-9._:-]*$` に限る。
  - `packages` が無いのに書いたら、理由を示して止める。
- dnf・microdnf・yum では `--enablerepo=<ID>` を付けて入れる。apt-get のイメージで書いたら、理由を示して止める。
- ID があるときだけ `--build-arg SACTY_ENABLE_REPOS` を渡し、作り直しの判定（ハッシュ）にも含める。書かなければ、ハッシュも
  実行するコマンドもこれまでと同じ。
- 元のイメージに git が無いときに git を入れる手順と、`run` のコマンドには `enable_repos` を効かせない（`run` で dnf を使うときは、
  そこで `--enablerepo` を書く）。

## 理由

- ID の形を限るのは、Dockerfile の RUN に展開するので、シェルの注入を防ぐため（PR の本文・コミット）。
- `packages` が無いときに止めるのは、書いても効かないため（PR の本文）。
- 書かなければハッシュはこれまでと同じで、既存のイメージは作り直されない、と PR の本文に書かれている（そうした理由としては明示されていない）。
- 比べたほかの案は記録に無い。

## 影響

- 無効の repo にあるパッケージを、`run` で `--enablerepo` を書かずに入れられる。
- `enable_repos` を変えると、`sacty image build` で作り直される。
- `run` で dnf を使うときは、`enable_repos` は効かない。
