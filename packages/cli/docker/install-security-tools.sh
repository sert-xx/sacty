#!/bin/sh
# セキュリティの検査の道具（osv-scanner：Apache-2.0、gitleaks：MIT）を、イメージに足す（Dockerfile から root で実行する）。
# 進め方 security-check・security-fix の工程とゴールガーディアンが、依存の脆弱性と秘密情報の混入を確かめるのに使う。
# 公式のリリース（GitHub）の単体のバイナリを、版とハッシュを固定して取る（ハッシュは取得元のリリースから取らない。リリースが
# すり替わっても、合わなければ止まるように）。版を上げるときは、このファイルの版と、アーキテクチャごとのハッシュ（リリースの
# osv-scanner_SHA256SUMS・gitleaks_<版>_checksums.txt の値を、取得した実物の sha256sum と突き合わせたもの）を変える
# （添付物の名前は、それぞれのリポジトリの .goreleaser.yml の決まり）。
# 取得できない・入れられないときは、警告して続ける（イメージは作れる。工程は、道具が無ければ確かめていない範囲として書く）。
# ハッシュが合わないときだけは止める（取得したものが壊れているか、すり替わっている）。
set -u

OSV_SCANNER_VERSION=2.7.0
OSV_SCANNER_SHA256_AMD64=160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b
OSV_SCANNER_SHA256_ARM64=4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
OSV_SCANNER_URL="https://github.com/google/osv-scanner/releases/download/v$OSV_SCANNER_VERSION"
GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION"

warn() {
  echo "sacty: 警告：$1 を入れません（$2）。セキュリティの工程は、この道具で確かめる範囲を「確かめていない範囲」として報告します。" >&2
}

case "$(uname -m)" in
  x86_64 | amd64)
    osv_arch=amd64; osv_sha="$OSV_SCANNER_SHA256_AMD64"
    gitleaks_arch=x64; gitleaks_sha="$GITLEAKS_SHA256_X64"
    ;;
  aarch64 | arm64)
    osv_arch=arm64; osv_sha="$OSV_SCANNER_SHA256_ARM64"
    gitleaks_arch=arm64; gitleaks_sha="$GITLEAKS_SHA256_ARM64"
    ;;
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

# 取得した添付物を、このファイルに固定したハッシュで確かめる。合わなければ止める
verify() {
  echo "$2  $dir/$1" | sha256sum -c - >/dev/null || {
    echo "sacty: 取得した $1 のハッシュが、固定したハッシュと合いません。取得したものが壊れているか、すり替わっています。" >&2
    exit 1
  }
}

if command -v osv-scanner >/dev/null 2>&1; then
  echo "sacty: osv-scanner は元のイメージにあるので、入れません。"
else
  file="osv-scanner_linux_$osv_arch"
  if fetch "$OSV_SCANNER_URL/$file" "$dir/$file"; then
    verify "$file" "$osv_sha"
    if install -m 0755 "$dir/$file" /usr/local/bin/osv-scanner; then
      echo "sacty: osv-scanner $OSV_SCANNER_VERSION を入れました。"
    else
      warn "osv-scanner" "/usr/local/bin に置けない"
    fi
  else
    warn "osv-scanner" "$OSV_SCANNER_URL から取得できない"
  fi
fi

if command -v gitleaks >/dev/null 2>&1; then
  echo "sacty: gitleaks は元のイメージにあるので、入れません。"
else
  file="gitleaks_${GITLEAKS_VERSION}_linux_$gitleaks_arch.tar.gz"
  if fetch "$GITLEAKS_URL/$file" "$dir/$file"; then
    verify "$file" "$gitleaks_sha"
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
    warn "gitleaks" "$GITLEAKS_URL から取得できない"
  fi
fi
exit 0
