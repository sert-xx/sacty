# 観点担当の出力の形式

観点担当（スキル review-execution）が返し、親（aggregation.md）が読む、1観点の結果の形式。review-execution の SKILL.md の「出力形式」と同じ内容（変えるときは両方を変える）。担当は JSON だけを返し、前後に説明を付けない。人向けの文章は日本語で書く。

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

- `status` は、`must` か `should` が1件以上なら `changes_required`、無ければ `passed`。入力が足りず観点を見られなかったときは `failed` にし、`limitations` に理由を書く（部分的な結果を `passed` にしない）
- `path` と `line` は、コードなら対象のリポジトリのルートからのパスと、対象の先頭（PR の先頭コミット）での行番号。文書なら見出しや行。複数箇所に及ぶときは代表の1箇所にして `problem` に他を書く
- `findings` は `must` → `should` → `nit` の順、同じ重要度では影響の大きい順
