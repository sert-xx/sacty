**日本語** | [English](gateway.en.md)

# ゲートウェイ

デーモンの中で動く HTTP の中継。エージェントのコンテナから、AI の呼び出し・組織内 PF の API・MCP サーバーを使うときに、認証の値を
コンテナに渡さず、ゲートウェイが付けて転送する。コンテナには実行ごとのトークンだけを渡す。

関係する ADR: [コンテキストの mcp.yaml の command の MCP サーバーを、既定でホストで起動してゲートウェイ経由にする](../adr/20261014-0927-context-command-mcp-on-host.md)、[ゲートウェイが受け取る本文に上限を設ける](../adr/20261018-0450-gateway-body-limit.md)

## 待ち受けとトークン

- `127.0.0.1` の空いているポートで待ち受ける（ポートを決める設定は無い）。コンテナからは `http://host.docker.internal:<ポート>` で
  つなぐ（`--add-host host.docker.internal:<gateway.host_address>`。既定 `host-gateway`）。
- 実行ごとにトークン `sacty-gw-<48桁の16進>` を発行し、その実行が使う AI の接続先・MCP・プロジェクトのコンテキストの PF を結びつける。
  実行が終わったら消す（以後は 401）。トークンは出力から伏せる対象に入れる。
- 中継の途中の失敗は、そのリクエストだけを終わらせる（返し始める前なら 502）。誤りの応答は `{ error: { message, type: "sacty_gateway" } }`。
- 受け取る本文（すべての中継で共通。上流へ送る前にホストのメモリーにためる）には、上限を設ける。超えたら、それ以上ためずに理由を返し、
  接続を切る。
  - 1 つの要求は 64 MiB（`GATEWAY_BODY_MAX`）まで。超えたら 413。`Content-Length` が上限を超えていれば読む前に断り、無くても（chunked でも）
    受け取った量で止める。
  - 同時に受け取っている本文の合計は 256 MiB（`GATEWAY_BODIES_MAX`）まで。超えたら 503（`Retry-After: 1`）。ためた分は、応答を返し終える
    （接続が閉じる）まで数える。
  - 受け取った分は 16 KiB（`GATEWAY_BODY_BLOCK`）のブロックに写して持ち、合計には確保したブロックの大きさで数える（細かい chunk を大量に
    送られても、数えた量より多くのメモリーを使わない）。
- 上流へは、宛先・認証・長さ・接続・圧縮・`expect`（curl などが大きな本文に付ける `100-continue`）のヘッダーを送らない。

| パス | 用途 | 認証 |
| --- | --- | --- |
| `/r/<トークン>/pf/<PF の名前>/<パス>` | 組織内 PF（エージェントには `SACTY_PF_URL` = `…/r/<トークン>/pf` を渡す） | URL の中のトークン |
| `/ctx-mcp/<名前>` | コンテキストリポジトリの MCP（URL 型の中継と、ホストで起動したコマンド型） | `Authorization: Bearer <トークン>` |
| `/mcp/<名前>` | ホストの MCP サーバー | `Authorization: Bearer <トークン>` |
| `/openai/v1/…` | AI の呼び出し（Codex の Bedrock・providers） | `Authorization: Bearer <トークン>`（`AWS_BEARER_TOKEN_BEDROCK`・`SACTY_PROVIDER_API_KEY` に入れて渡す） |

コード: `apps/daemon/src/gateway.ts`（`AiGateway.listen`・`register`・`handle`・`containerOrigin`・`platformsUrl`・`DEFAULT_HOST_ADDRESS`・`readBody`・`GATEWAY_BODY_MAX`・`GATEWAY_BODIES_MAX`・`GATEWAY_BODY_BLOCK`・`DROP_REQUEST`）、`apps/daemon/src/service.ts`（`executeLogged`）

## AI の呼び出しの中継

- 転送先は、Bedrock なら `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`（`endpoint: runtime`。既定）か
  `https://bedrock-mantle.<region>.api.aws/openai/v1`（`mantle`）、providers なら `base_url`。API キーはホストで取り出して `Authorization: Bearer`
  で付ける。エージェントが付けた `authorization`・`host` などのヘッダーは送らない。
- 429・500・502・503・504 と、上流に届かなかったときは、`Retry-After`（秒か日時）か、無ければ1秒から倍にしていく間隔（60秒で頭打ち。
  揺らぎを加える）で待ってリトライする。それ以外の応答はそのまま流す。返し始めた後はリトライしない。
- 上限は `gateway.retry.max_attempts`（1件のリクエストで送る回数。既定 8）と `max_wait_sec`（一続きの失敗で待つ合計。既定 600）。リクエスト
  ごとに設定を読み直す。成功（2xx）で待った合計を戻す。上限に達したら、最後の上流の応答か、理由の文（502 など）を返し、その実行の後の
  リクエストは待たずに1回だけ送る。その後のエージェントの失敗は、出力の文で理由を分ける（[エージェントの実行](agent-execution.md)の
  「出力の扱い」）。
- リトライした実行は、回数・待った時間・原因の状態・あきらめたかを `AiRequestsRetried` に記録する。

コード: `apps/daemon/src/gateway.ts`（`RETRYABLE`・`BASE_DELAY_MS`・`MAX_DELAY_MS`・`DEFAULT_RETRY_POLICY`・`retryAfterMs`・`GatewayStats`）、`apps/daemon/src/service.ts`（`bedrockOrigin`・`recordRetries`）

## 組織内 PF の中継

PF は `config.yaml` の `gateway.platforms`（すべてのプロジェクト）か、コンテキストリポジトリの `platforms.yaml`（そのプロジェクト）に書く。

| 項目 | 意味 |
| --- | --- |
| `upstream` | 転送先（http・https） |
| `description` | エージェントへの説明（既定 空） |
| `auth.header`・`auth.prefix` | 認証を付けるヘッダー（既定 `Authorization`）と値の前に付ける文字列（既定 空） |
| `auth.secret` | 固定のキー（秘密情報の参照） |
| `auth.token` | キーでトークンを取得する：`url`・`method`（既定 `POST`）・`headers`・`query`・`json`・`form`（`{{secret}}` をキーに置き換える）・`secret`・`token_path`・`expires_in_path`・`ttl_sec`（既定 300） |
| `allow` | 使える API の一覧（`<メソッド> /<パス>`。1件以上） |

`auth.secret` と `auth.token` はどちらか一方だけ書く。

`auth.token` の検査（設定の読み込みのときに弾く）：

- `url` は http・https。`{{secret}}` を含められない（キーをクエリで送るなら `query` に書く。`config.platformTokenUrlSecret`）。
- `query` は「名前: 値」（名前は空でない文字列、値は文字列。`config.platformTokenQuery`）。
- `method` が `GET`・`HEAD` のときは `json`・`form` を書けない（`config.platformTokenBody`）。

トークンの窓口の URL（`tokenUrl`）：`query` の値の `{{secret}}` をキーに置き換え、名前と値を URL エンコードして（`encodeURIComponent`
に加えて `!'()*` も変える。空白は `%20`）、`url` に元からあるクエリの後ろに `&` でつないで足す。元からあるクエリは書き換えない。
`url` の `#` 以降は送らない。`query` を書かない（空も）ときは `url` をそのまま送る。`GET` で `json`・`form` が無ければ本文と
`content-type` を付けない。

トークンを取得できなかった理由（画面・ログ・作業履歴・ゲートウェイの応答に出す）は、キーを伏せてから600文字に切り詰める。伏せる形は、
値そのもの・JSON の文字列にした形・URL に現れうる形・各行（どれも4文字以上。`HIDE_MIN_LENGTH`）（`hideSecret`・`urlPattern`）。
URL に現れうる形は、文字ごとに、そのままか UTF-8 のパーセントエスケープ（16進の大文字・小文字を問わず、`%25` の二重のエンコードも）で、
空白は `+` も。エスケープの箇所ごとに違ってもよい。対になっていないサロゲートはそのままだけ。クエリの値の全体がキーのとき
（`?名前=値`・`&名前=値` の値が上の形で、後ろが値を続けられる文字（英数字・`-._~`・`%`・`+`）でない、つまり文の終わり・`&`・`#`・`:`・
`)`・`]`・`,`・`;`・空白・改行・引用符などのどれか）は、長さに関係なく伏せる（名前は256文字まで）。トークンの取得の理由では、キーに加えて、
送ったクエリの値のうちキーを入れたもの（`pre-{{secret}}` を置き換えた `pre-<キー>` など）も、値の丸ごとを同じ規則で伏せる
（長いものから。`sentQueryValues`）。
送信の失敗の文（URL を含むもの）にも、窓口の HTTP のエラーの本文にも同じく伏せる。

ただし、`query` の値にキー（`{{secret}}`）を入れた窓口が失敗の状態（2xx 以外）を返したときは、本文を理由に写さず、状態コードだけにする
（`token endpoint returned <状態> (the response body is not shown because the key is sent in the query)`。`sendsKeyInQuery`）。
窓口は送った名前・値を、URL・`api_token=abc`・JSON など、どんな形でも本文に返しうり、短いキーは形を問わずには伏せられないため。
伏せる規則だけに頼って残る形は次のとおり。

- 送信の失敗の文（fetch の例外の文）で、短いキー（4文字未満）・短い送った値が、クエリの値（`?`・`&` の後ろの `名前=値`）の全体
  ではない形で現れたとき（Node の fetch の失敗の文は `fetch failed` で、URL を含まない。`cause` は理由に入れない）。
- キーを本文・ヘッダーで送る窓口（`query` にキーを入れない）の失敗の本文に、短いキーが現れたとき（これまでどおり。4文字以上を伏せる）。

- 探す順は、ホストの PF、無ければその実行のトークンに結びつけたプロジェクトのコンテキストの PF。ほかのプロジェクトのタスクの
  トークンでは見つからない（404）。
- `allow` の `*` は1階層、`**` はそれより下のすべて（末尾の `/**` はその階層そのものにも合う）。クエリは見ない。`.`・`..` の階層・`%2e`・
  `%2f`・`\` を含むパスは合わない。URL にすると変わるパス（`#` や空白を含むなど）は 400。合わなければ 403（使える API の一覧を返す）。
- 送るヘッダーから、エージェントの認証・`cookie`・PF の認証のヘッダーを除き、認証の値を付ける。リダイレクトはたどらない。
- トークンは期限（`expires_in_path`、無ければ `ttl_sec`）の30秒前から取り直す。`auth.token` の PF で 401・403 が返ったら、取り直して1回だけ
  送り直す。
- 認証の値を用意できなければ 502（どの PF か、コンテキストの PF ならどの層か）、上流に届かなければ 502。
- ホストの PF の認証は、デーモンの起動のときに用意する。用意できないホストの PF は、画面の警告に出す（ほかの PF は使える）。
- エージェントの指示に、そのタスクで使える PF と API の一覧を入れる。

コード: `apps/daemon/src/platforms.ts`（`PlatformFile`・`TokenRequest`・`tokenUrl`・`hideSecret`・`pathPattern`・`isAllowed`・`PlatformCredentials`・`REASON_MAX`・`REFRESH_MARGIN_MS`・`platformPromptLines`）、`apps/daemon/src/gateway.ts`（`handlePlatform`・`sentUrl`）

## コンテキストの MCP の中継

`/ctx-mcp/<名前>` は、実行のトークンに結びつけた名前だけを引く（ほかの実行・ほかのプロジェクトのものは、名前を知っていても 404）。
結びつけた先が、URL 型ならその上流に中継し、ホストで起動したコマンド型なら、ゲートウェイの中の名前（`ctx-…`）のホストの MCP サーバーに
中継する（[コンテキストの合成](context.md)の「ホストで起動するコマンド型の MCP サーバー」）。ホストで起動したコマンド型は `/mcp/` からは
使えない。

URL 型の中継：

- 上流には `content-type`・`accept`・`mcp-session-id`・`mcp-protocol-version`・`last-event-id` のヘッダーだけを送り、`mcp.yaml` に書いた
  ヘッダー（秘密情報はホストで取り出す）を付ける。エージェントが付けた認証などは送らない。
- 応答（SSE を含む）はそのまま流す。リダイレクトはたどらない。上流に届かなければ 502（どの MCP サーバーか、`mcp.yaml` の名前を添える）。
- 上流を待つ上限は既定5分（`FETCH_DEFAULT_TIMEOUT_MS`）。サーバーの `startup_timeout_sec`・`tool_timeout_sec` の大きい方がそれより長ければ、
  その値まで延ばす。

コード: `apps/daemon/src/gateway.ts`（`handle`・`handleContextMcp`・`relayHostMcp`・`ContextMcpRoute`・`CONTEXT_MCP_REQUEST`・`FETCH_DEFAULT_TIMEOUT_MS`・`contextMcpDispatcher`）、`apps/daemon/src/service.ts`（`executeLogged`）

## ホストの MCP サーバー

`gateway.mcp_servers.<名前>` のコマンドを、ゲートウェイがホストで起動して持ち続け、エージェントには HTTP の MCP（`/mcp/<名前>`）として渡す。
コンテキストリポジトリのコマンド型の MCP サーバーも、同じ仕組み（別の集まり）でホストで起動する。違いは、起動するものを実行ごとの確保で
決めること・作業ディレクトリが層の写しであること・準備を待つ上限（[コンテキストの合成](context.md)）。起動する前に、コマンドがホストに
あるか（`/` を含むものは作業ディレクトリから、ほかは `PATH` から）を確かめる。

| 項目 | 意味 |
| --- | --- |
| `command`・`args` | 起動するコマンド（シェルは使わない） |
| `env` | 環境変数（ホストの環境変数に足す）。値は文字列か `{ secret, prefix }` |
| `description` | 説明（既定 空） |
| `restart_every_min` | 認証の期限の前に起動し直す間隔（1〜10080 分。任意） |
| `ready_timeout_sec` | 起動から準備（初期化）ができるまで待つ上限（5〜3600 秒。既定 300） |
| `startup_timeout_sec`・`tool_timeout_sec` | エージェントに渡す時間切れ（`mcp.yaml` と同じ） |

- 設定は30秒ごとと、実行の前に突き合わせる（消えたものを止め、足したものを起動し、変わったものを起動し直す。時間切れだけを変えたときは
  起動し直さない）。
- 起動し直すとき（`restart_every_min`・プロセスの終了・ツールが認証エラーらしい結果を返した・接続が切れた）は、新しいプロセスの準備が
  できてから切り替え、古い接続は途中の呼び出しが終わるまで（最大5分）待ってから閉じる。認証エラーのときは1回だけ起動し直し、結果に
  しばらくしてからやり直すよう添える。
- 起動に失敗したら理由（秘密情報を伏せる）を画面の警告に出し、1分ごとに起動し直す。準備ができていない間の呼び出しには 503 を返す
  （コンテキストのものは、`mcp.yaml` の名前・層・プロジェクトの名前を添え、ゲートウェイの中の名前は返さない）。
- ログ（起動・起動し直し・準備できない・止める・プロセスの記録の失敗・前回の残りの片付け）には、どの MCP サーバーかを出す（`mcpLogName`）。
  ホストの MCP サーバーは `host MCP <名前>`、コンテキストのものは
  `context MCP "<mcp.yaml の名前>" (project "<プロジェクトの名前>" [<プロジェクトの ID>], context "<層>", internal ctx-…)`。プロセスの記録
  （下の「記録」）にも、この名前を書き、前回の残りを止めたログに出す。標準エラー・環境変数の秘密情報は、理由と同じく伏せる（ログに出すのは
  伏せた後の理由だけ）。
- 実行の前に、その実行が使う MCP サーバーの準備を `ready_timeout_sec` まで待つ。できなければ、どのサーバーかをコンテキストの警告に
  残して実行する（書き出しでは、その接続先への書き出しを止める）。
- 中継の時間切れは、ツールの呼び出しが10分（`CALL_TIMEOUT_MS`）か `tool_timeout_sec` の大きい方、一覧が60秒（`LIST_TIMEOUT_MS`）か
  `startup_timeout_sec` の大きい方。
- プロセスは、それぞれ自分のプロセスグループで起動する（`detached`）。閉じるときは標準入力を閉じて2秒待ち、プロセスグループと子孫に
  SIGTERM を送り、3秒で終わらなければ SIGKILL を送る。
- 記録：起動したプロセス（PID・開始時刻・子孫・起動したデーモン）を `SACTY_HOME/host-mcp/processes/<PID>.json` に書き、子孫は10秒ごとに
  書き直す。デーモンの起動のとき、記録を書いたデーモンが動いていないものだけを、PID と開始時刻が一致するときに止める（PID が
  再利用されたほかのプロセスや、同じ `SACTY_HOME` で動いているほかの sacty のものは止めない）。`ps` を読めなければ何も止めない。

コード: `apps/daemon/src/host-mcp.ts`（`HostMcpFile`・`HostMcpServers`・`reconcile`・`ready`・`restart`・`drain`・`assertCommand`・`mcpLogName`・`AUTH_ERROR`・`RETRY_MS`・`CALL_TIMEOUT_MS`・`LIST_TIMEOUT_MS`）、`apps/daemon/src/context-mcp.ts`（`ContextMcpServers`）、`apps/daemon/src/host-mcp-processes.ts`（`HostMcpProcesses`・`GroupStdioTransport`・`cleanup`・`terminate`）、`apps/daemon/src/service.ts`（`mcpRouting`・`runContext`）
