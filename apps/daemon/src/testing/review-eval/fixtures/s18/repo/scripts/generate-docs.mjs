// openapi/library.yaml から docs/api-reference.md を作る。
// 使い方：node scripts/generate-docs.mjs [出力先]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = new URL("..", import.meta.url);
const spec = parse(readFileSync(new URL("openapi/library.yaml", root), "utf8"));
const out = process.argv[2] ?? fileURLToPath(new URL("docs/api-reference.md", root));

const typeOf = (schema) => {
  if (!schema) return "";
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (Array.isArray(schema.type)) return schema.type.join(" \\| ");
  if (schema.type === "array") return `${typeOf(schema.items)}[]`;
  if (schema.format) return `${schema.type} (${schema.format})`;
  return schema.type ?? "";
};

const lines = [
  "<!-- このファイルは scripts/generate-docs.mjs が openapi/library.yaml から作ります。直接編集しないでください。 -->",
  "",
  `# ${spec.info.title} ${spec.info.version}`,
  "",
  spec.info.description,
  "",
  "## エンドポイント",
  "",
  "| メソッド | パス | operationId | 内容 |",
  "| --- | --- | --- | --- |",
];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    lines.push(`| ${method.toUpperCase()} | \`${path}\` | \`${op.operationId}\` | ${op.summary} |`);
  }
}
lines.push("", "## スキーマ", "");
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  lines.push(`### ${name}`, "");
  if (schema.enum) {
    lines.push(`値：${schema.enum.map((v) => `\`${v}\``).join("、")}`, "");
    continue;
  }
  const required = new Set(schema.required ?? []);
  lines.push("| 項目 | 型 | 必須 | 説明 |", "| --- | --- | --- | --- |");
  const walk = (props, prefix) => {
    for (const [key, prop] of Object.entries(props ?? {})) {
      lines.push(
        `| ${prefix}${key} | ${typeOf(prop)} | ${required.has(key) ? "○" : ""} | ${prop.description ?? ""} |`,
      );
    }
  };
  walk(schema.properties, "");
  lines.push("");
}
writeFileSync(out, `${lines.join("\n")}\n`);
