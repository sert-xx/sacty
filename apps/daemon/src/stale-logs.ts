/**
 * エラーレポートの API の、閉じられなかった実行のログを省く入力（クエリ）と、省いたことを示す印（応答のヘッダー）。
 * 受け口と sacty mcp が同じ値を使う。デーモンの本体が MCP サーバーの層を読み込まないよう、ほかに依存しない。
 */
export const STALE_LOGS_QUERY = "stale";
export const STALE_LOGS_OMIT = "omit";
export const STALE_LOGS_HEADER = "x-sacty-stale-logs";
export const STALE_LOGS_OMITTED = "omitted";
