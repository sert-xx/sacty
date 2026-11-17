# 観点担当の出力の形式

観点担当（スキル review-execution）が返し、親（aggregation.md）が読む、1観点の結果の形式。review-execution の SKILL.md の「出力形式」と同じ内容（変えるときは両方を変える）。担当は JSON だけを返し、前後に説明を付けない。人向けの文章は日本語で書き、書き方はスキル `writing` に従う。

```json
{
  "viewpoint": "C-1",
  "status": "passed | changes_required | failed",
  "findings": [
    {
      "severity": "must | should | nit",
      "path": "src/pay.ts",
      "line": 12,
      "title": "命令形の短い見出し（例：金額が 0 のとき割り算で例外になる）",
      "problem": "何が・どの入力や経路で・どう問題か",
      "condition": "起きる条件。何と何が重なると起きるか（ふつうの使い方で起きるなら、そう書く）",
      "impact": "起きたときの実害。誰が・何を失うか、何が止まるか",
      "likelihood": "normal | conditional | rare",
      "impact_level": "high | medium | low",
      "evidence": "確かめた事実（読んだ箇所、追った経路、実行した結果）。推測は「推測：」と前置きする",
      "suggestion": "どう直すとよいか",
      "confidence": "high | medium | low"
    }
  ],
  "out_of_scope_notes": ["観点の外で気づいたことを1行ずつ（親が他の観点の結果と照らす）"],
  "checked": ["観点の「見るもの」ごとに、何をどこまで確かめたか"],
  "limitations": ["足りなかった入力、読めなかった箇所、実行できなかった確認"]
}
```

- `viewpoint` は、依頼された観点の ID（リポジトリのレビュー用のスキルの担当は `R-1` など）
- `status` は、`must` か `should` が1件以上なら `changes_required`、無ければ `passed`。入力が足りず観点を見られなかったときは `failed` にし、`limitations` に理由を書く（部分的な結果を `passed` にしない）。依頼文の範囲の外を見なかったことは `failed` の理由にしない（範囲の外は、もとから見るものではない）。`limitations` にも書かず、見た範囲を `checked` に書く
- `path` と `line` は、コードなら対象のリポジトリのルートからのパスと、対象の先頭（PR の先頭コミット）での行番号。文書なら見出しや行。PR の本文で示された文書の写しなら、`path` は写しのパスではなく取得元（文書の名前か URL）、`line` は節の見出し。複数箇所に及ぶときは代表の1箇所にして `problem` に他を書く
- `condition`・`impact`・`likelihood`・`impact_level` は、すべての指摘に書く（`nit` は `impact` に「実害なし」と書き、`impact_level` は `low`）。`severity` は、review-execution の「重要度」の表のとおりにする（影響：大は `must`。影響：中は、稀なら `should`、それ以外は `must`。影響：小は `should`、稀なら出さない。受け入れ条件・要求要件の不適合は、起きやすさを問わず `must`）。受け入れ条件・要求要件の不適合を理由に `must` にしたときは、`impact` に、根拠のどの条件を、根拠が述べるどの場面で満たしていないかを書く
- `findings` は `must` → `should` → `nit` の順、同じ重要度では影響の大きい順
