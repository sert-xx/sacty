#!/bin/sh
# セキュリティの検査の道具（osv-scanner：Apache-2.0、gitleaks：MIT）を、イメージに足す（Dockerfile から root で実行する）。
# 進め方 security-check・security-fix の工程とゴールガーディアンが、依存の脆弱性と秘密情報の混入を確かめるのに使う。
# 公式のリリース（GitHub）の単体のバイナリを、版を固定して取り、同じリリースのハッシュのファイルで確かめる。版を上げるときは、
# このファイルの版を変える（添付物の名前は、それぞれのリポジトリの .goreleaser.yml の決まり）。
# 取得できない・入れられないときは、警告して続ける（イメージは作れる。工程は、道具が無ければ確かめていない範囲として書く）。
# ハッシュが合わないときだけは止める（取得したものが壊れているか、すり替わっている）。
set -u

OSV_SCANNER_VERSION=2.7.0
GITLEAKS_VERSION=8.30.1
OSV_SCANNER_URL="https://github.com/google/osv-scanner/releases/download/v$OSV_SCANNER_VERSION"
GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION"

warn() {
  echo "sacty: 警告：$1 を入れません（$2）。セキュリティの工程は、この道具で確かめる範囲を「確かめていない範囲」として報告します。" >&2
}

case "$(uname -m)" in
  x86_64 | amd64) osv_arch=amd64; gitleaks_arch=x64 ;;
  aarch64 | arm64) osv_arch=arm64; gitleaks_arch=arm64 ;;
  *)
    warn "osv-scanner・gitleaks" "リリースの無いアーキテクチャ：$(uname -m)"
    exit 0
    ;;
esac
if ! command -v curl >/dev/null 2>&1; then
  warn "osv-scanner・gitleaks" "curl が無い"
  exit 0
fi

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

# 接続や転送が止まっても、いつまでも待たずに警告して続ける（install-drawio.sh と同じ上限）
fetch() {
  curl -fsSL --connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time 900 \
    --retry 3 --retry-max-time 1200 -o "$2" "$1"
}

# ハッシュのファイルから、添付物の行だけを取り出して確かめる。合わなければ止める
verify() {
  name="$1"
  sums="$2"
  line="$(grep -E "[[:space:]]\*?$name\$" "$sums")" || return 2
  echo "$line" | sed 's/ \*/  /' | (cd "$dir" && sha256sum -c - >/dev/null) || {
    echo "sacty: 取得した $name のハッシュが、リリースのハッシュのファイルと合いません。取得したものが壊れているか、すり替わっています。" >&2
    exit 1
  }
}

if command -v osv-scanner >/dev/null 2>&1; then
  echo "sacty: osv-scanner は元のイメージにあるので、入れません。"
else
  file="osv-scanner_linux_$osv_arch"
  if fetch "$OSV_SCANNER_URL/osv-scanner_SHA256SUMS" "$dir/osv-scanner.sums" \
    && fetch "$OSV_SCANNER_URL/$file" "$dir/$file"; then
    if verify "$file" "$dir/osv-scanner.sums"; then
      if install -m 0755 "$dir/$file" /usr/local/bin/osv-scanner; then
        echo "sacty: osv-scanner $OSV_SCANNER_VERSION を入れました。"
      else
        warn "osv-scanner" "/usr/local/bin に置けない"
      fi
    else
      warn "osv-scanner" "ハッシュのファイルに $file の行が無い"
    fi
  else
    warn "osv-scanner" "$OSV_SCANNER_URL から取得できない"
  fi
fi

if command -v gitleaks >/dev/null 2>&1; then
  echo "sacty: gitleaks は元のイメージにあるので、入れません。"
else
  file="gitleaks_${GITLEAKS_VERSION}_linux_$gitleaks_arch.tar.gz"
  if fetch "$GITLEAKS_URL/gitleaks_${GITLEAKS_VERSION}_checksums.txt" "$dir/gitleaks.sums" \
    && fetch "$GITLEAKS_URL/$file" "$dir/$file"; then
    if verify "$file" "$dir/gitleaks.sums"; then
      if tar -xzf "$dir/$file" -C "$dir" gitleaks; then
        if install -m 0755 "$dir/gitleaks" /usr/local/bin/gitleaks; then
          echo "sacty: gitleaks $GITLEAKS_VERSION を入れました。"
        else
          warn "gitleaks" "/usr/local/bin に置けない"
        fi
      else
        warn "gitleaks" "$file を展開できない"
      fi
    else
      warn "gitleaks" "ハッシュのファイルに $file の行が無い"
    fi
  else
    warn "gitleaks" "$GITLEAKS_URL から取得できない"
  fi
fi
exit 0
