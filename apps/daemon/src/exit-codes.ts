/**
 * デーモンの終了コードのうち、`sacty up` が見分けるもの（CLI からも読むので、node:sqlite などを読み込まない
 * ここに置く）。
 */

/** 同じ SACTY_HOME でほかのデーモンが動いているため、起動しなかった（PBI-79）。 */
export const ALREADY_RUNNING_EXIT_CODE = 3;
