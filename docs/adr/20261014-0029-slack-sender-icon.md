# sacty のアイコンを作り、Slack の通知の送り手（名前 Sacty・icon_url）と画面のアイコンに使う

- 日時: 2026-10-14 00:29 UTC
- ステータス: 採用
- 関係する PR・タスク: #74、PBI-68
- 置き換え元: なし
- 置き換え先: なし

## 背景

sacty には自分のアイコンが無く、Slack の通知の送り手と画面のアイコンに使うものが無かった。

## 決定

- アイコンは、S の線でつながる2つのノード（エージェントと工程の流れ）。濃い藍の背景・藍の線・白と黄の点。
  `assets/sacty-icon.svg`・`assets/sacty-icon.png`（512×512）に置く。
- Slack API（chat.postMessage）の本文に `username: "Sacty"` と `icon_url` を付ける。`icon_url` は、このリポジトリの main の
  `assets/sacty-icon.png` の raw の URL。絵文字のアイコン（`icon_emoji`）は使わない。Incoming Webhook はこれまでどおり送り手を指定しない。
- 画面のファビコン（16・32・48px と SVG）・ホーム画面用（180px）を差し替え、ヘッダーの「sacty」の左にマークを置く
  （暗い表示では薄い縁取り。読み上げからは外す）。
- README に、送り手の名前とアイコン、`chat:write.customize` の権限が無いと Slack は指定を無視することを書く。

## 理由

- Incoming Webhook に送り手を指定しないのは、新しい形の Webhook は送り手の指定を無視するため（PR の本文）。
- 最初のコミットでは送り手のアイコンを絵文字（`:factory:`）にしたが、後のコミットで作ったアイコンの `icon_url` に変えた。
  変えた理由は記録に無い。
- 既存の製品のロゴとの重なりを調べ、いちばん近いもの（曲線2本と円2つのロゴ）とは、1本につながった S と色で区別できると判断した
  （公開情報の検索による。商標の調査はしていない）。

## 影響

- `icon_url` は main の URL を指すので、画像はこの PR が main にマージされてから表示される。
- Slack のアプリに `chat:write.customize` の権限が無いと、名前とアイコンの指定は無視される。
- 実際の Slack への送信は、この PR の時点では確かめていない。
