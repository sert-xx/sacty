/**
 * デーモンの終了コードのうち、`sacty up` が見分けるものと、`sacty up` がデーモンに送るシグナル（CLI からも読むので、
 * node:sqlite などを読み込まないここに置く）。
 */

/** 同じ SACTY_HOME でほかのデーモンが動いているため、起動しなかった（PBI-79）。 */
export const ALREADY_RUNNING_EXIT_CODE = 3;

/** 止めている途中のデーモンを、後片付けを待たずに終わらせるシグナル（止めている途中で、もう一度 Ctrl+C を押されたとき）。 */
export const FORCE_STOP_SIGNAL = "SIGUSR2";
