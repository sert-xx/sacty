# 答えの JSON の検査

答えの JSON を出す前に、道具で検査する手順。
目で見て確かめるだけでは、閉じ括弧の欠け・末尾のカンマ・エスケープの漏れを見落とす。

## 1. ファイルに書く

答えの JSON を、作業領域の外のファイルに書く（対象のリポジトリの中に残さない）。

```sh
f="$(mktemp)"
cat > "$f" <<'JSON'
{"<見出し>": {"plan": "...", "reason": "..."}}
JSON
```

## 2. 構文を確かめる

使える道具のうち、上から最初に見つかるものを使う。
どれかが使えればよい（`jq` が無い環境もある）。

| 道具 | 構文の検査 |
| --- | --- |
| `jq` | `jq -e . "$f" > /dev/null` |
| `python3` | `python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$f"` |
| `node` | `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f"` |

終了コードが 0 なら通った。
0 でなければ、誤りの文（行・桁・足りない文字）を読んで直し、もう一度この手順から確かめる。

どの道具も無いときは、括弧・引用符の対応を先頭から数えて確かめ、答えの前に「道具で検査できなかった」と 1 行書く。

## 3. 形を確かめる

依頼した見出しと、必ず書く項目があることを確かめる。
見出しと項目の名前は、依頼の形のものに置き換える。

| 道具 | 形の検査（例：見出し `<見出し>`、必ず書く項目 `plan`・`reason`） |
| --- | --- |
| `jq` | `jq -e '.["<見出し>"] \| type == "object" and (.plan \| type == "string") and (.reason \| type == "string")' "$f" > /dev/null` |
| `python3` | `python3 -c 'import json, sys; v = json.load(open(sys.argv[1]))["<見出し>"]; assert isinstance(v["plan"], str) and isinstance(v["reason"], str)' "$f"` |
| `node` | `node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["<見出し>"]; if (typeof v.plan !== "string" \|\| typeof v.reason !== "string") process.exit(1)' "$f"` |

あわせて、次も見直す。

- 候補を書く項目に、選んだ 1 つの値だけが入っている（形の例の「A または B」を写していない）。
- 形の例の注釈（括弧書き）が、キーや値に混ざっていない。
- 「要らなければ書かない」項目を、空の値で埋めていない。

## 4. 通るまで直す

構文か形の検査に通らなければ、直してから 2 に戻る。
通るまで繰り返す。直した回数の上限は無い。
同じ誤りが 3 回続いたら、継ぎ足しで直さず、答えを一から書き直す。

## 5. 出す

通ったファイルの中身をそのまま出す（`cat "$f"`）。
出す前に手で書き換えたら、もう一度 2 から確かめる。
答えは本文の最後に 1 回だけ出し、検査に使った途中の JSON は本文に出さない。
