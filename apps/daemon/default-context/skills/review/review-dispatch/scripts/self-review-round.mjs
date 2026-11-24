const round = process.argv[2];
if (
  !round ||
  !/^[1-9]\d*$/.test(round) ||
  !Number.isSafeInteger(Number(round)) ||
  (process.argv[3] !== undefined && process.argv[3] !== "--rereview") ||
  process.argv.length > 4
) {
  process.stderr.write("Specify a positive review round.\n");
  process.exit(1);
}
if (Number(round) > 1 || process.argv[3] === "--rereview") {
  process.stdout.write(
    [
      "再レビューでは、前回以降の変更が生んだ後退、直っていない前回の要修正（重みの見直しの規則を適用）、ふつうの使い方か1つの条件で起きる不適合または影響が大のもの、ふつうの使い方で起き影響が中のものだけを要修正にする。1つの条件で起き影響が中で不適合でないものを含む、ほかの新しい指摘は表の重さによらず提案にする。",
      "同じ原因が続き、レビューが示した範囲を絞る案で残る現れが再レビューの要修正に当たらないものだけなら、その現れは提案にし、人の判断を求めず、印も needsDecision も付けない。その回の総評に、範囲を絞って提案にしたことと残る現れを書く。",
      "",
    ].join("\n"),
  );
}
