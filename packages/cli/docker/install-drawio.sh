#!/bin/sh
# draw.io の CLI（draw.io Desktop。Apache-2.0）を、イメージに足す（Dockerfile から root で実行する）。
# 既定のスキル drawio（apps/daemon/default-context/skills/drawio）が、Mermaid の変換・レイアウト・PNG・SVG・PDF の書き出しに使う。
# 公式のリリース（GitHub）のパッケージを、版とハッシュを固定して取る。版を上げるときは、このファイルの版とハッシュ
# （リリースの Files-SHA256-Hashes.txt）を変える。
# 取得できない・入れられないときは、警告して続ける（イメージは作れる。スキルは CLI が無ければ XML で図を作る）。
# ハッシュが合わないときだけは止める（取得したものが壊れているか、すり替わっている）。
set -u

VERSION=32.4.1
SHA256_AMD64_DEB=f4455b3bba3d3b539c3cd069218fc64f0462b1b01610fe8d11acc3ca8566f32b
SHA256_ARM64_DEB=724d3f18c18dc42489760c7811508581803824880d1e98e035e3a8dd3b5c7bba
SHA256_X86_64_RPM=68ad7b4743478913738b0bfc7bc1b5cf62fac4498d3985ff29274455d65d2189
SHA256_AARCH64_RPM=a96878567962e0443f9deb88d0951c8f53105dd91afdbc5717edf737fb61ab60
BASE_URL="https://github.com/jgraph/drawio-desktop/releases/download/v$VERSION"

warn() {
  echo "sacty: 警告：draw.io の CLI を入れません（$1）。図は XML で作れますが、Mermaid の変換と画像の書き出しはできません。" >&2
  exit 0
}

if [ "${SACTY_DRAWIO:-1}" != 1 ]; then
  echo "sacty: image_build.drawio が false なので、draw.io の CLI を入れません。"
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64) sha="$SHA256_AMD64_DEB" ;;
    arm64) sha="$SHA256_ARM64_DEB" ;;
    *) warn "draw.io のパッケージが無いアーキテクチャ：$arch" ;;
  esac
  file="drawio-$arch-$VERSION.deb"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64) sha="$SHA256_X86_64_RPM" ;;
    aarch64) sha="$SHA256_AARCH64_RPM" ;;
    *) warn "draw.io のパッケージが無いアーキテクチャ：$arch" ;;
  esac
  file="drawio-$arch-$VERSION.rpm"
  pm=dnf; command -v dnf >/dev/null 2>&1 || pm=yum
else
  warn "取得したパッケージを依存とともに入れられるパッケージの管理のコマンド（apt-get・dnf・yum）が無い"
fi
command -v curl >/dev/null 2>&1 || warn "curl が無い"

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
# 取得物を置いておく場所（Dockerfile が BuildKit の cache マウントで渡す。with-build-cache.sh）。無ければ使わない。
# 固定したハッシュと合うものがあれば、それを使う（取得しない）
cache="${SACTY_DOWNLOAD_CACHE:-}"
slot="$cache/drawio/$VERSION"
if [ -n "$cache" ] && [ -f "$slot/$file" ] \
  && echo "$sha  $slot/$file" | sha256sum -c - >/dev/null 2>&1 \
  && cp "$slot/$file" "$dir/$file"; then
  echo "sacty: ビルドのキャッシュにある $file を使います。"
else
  # 接続や転送が止まっても、いつまでも待たずに警告して続ける
  # （接続 30 秒、60 秒のあいだ 1KB/s を下回れば打ち切り、1 回 900 秒。再試行は 3 回までで、最初から 1200 秒を過ぎたら始めない。
  # 1200 秒の前に始めた再試行は最大 900 秒続くので、全体は 1200 秒を超えることがある（最長でおよそ 2100 秒））
  curl -fsSL --connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time 900 \
    --retry 3 --retry-max-time 1200 -o "$dir/$file" "$BASE_URL/$file" \
    || warn "$BASE_URL/$file を取得できない"
  if ! echo "$sha  $dir/$file" | sha256sum -c - >/dev/null; then
    echo "sacty: 取得した draw.io のパッケージ（$file）のハッシュが合いません。取得したものが壊れているか、すり替わっています。" >&2
    exit 1
  fi
  # キャッシュに置き、ほかの版を消す（置けなくても続ける）
  if [ -n "$cache" ]; then
    { mkdir -p "$slot" && cp "$dir/$file" "$slot/$file.tmp" && mv -f "$slot/$file.tmp" "$slot/$file"; } 2>/dev/null || true
    for old in "$cache/drawio"/*; do
      [ "$old" = "$slot" ] || rm -rf "$old"
    done
  fi
fi

# 画面の無いコンテナで動かすための仮想の画面（Xvfb）と、Electron が読む音と GBM のライブラリ（パッケージの依存に無い。
# --no-install-recommends では入らず、無いと本体が起動しない）を一緒に入れる
if command -v apt-get >/dev/null 2>&1; then
  apt-get update || warn "パッケージのミラーに届かない"
  # Ubuntu 24.04 からは libasound2t64 という名前
  alsa=libasound2; apt-cache show libasound2t64 >/dev/null 2>&1 && alsa=libasound2t64
  apt-get install -y --no-install-recommends "$dir/$file" xvfb "$alsa" libgbm1 \
    || { rm -rf /var/lib/apt/lists/*; warn "draw.io と依存のパッケージを入れられない"; }
  # 日本語などのラベルを書き出せるように、CJK のフォントを入れる（無くても動く）
  apt-get install -y --no-install-recommends fonts-noto-cjk \
    || echo "sacty: 警告：CJK のフォント（fonts-noto-cjk）を入れられませんでした。日本語のラベルは、書き出した画像で文字化けします。" >&2
  rm -rf /var/lib/apt/lists/*
else
  opts="-y --setopt=install_weak_deps=False"
  # shellcheck disable=SC2086
  $pm install $opts "$dir/$file" xorg-x11-server-Xvfb alsa-lib mesa-libgbm \
    || { $pm clean all >/dev/null 2>&1; warn "draw.io と依存のパッケージを入れられない"; }
  # shellcheck disable=SC2086
  $pm install $opts google-noto-sans-cjk-ttc-fonts \
    || echo "sacty: 警告：CJK のフォント（google-noto-sans-cjk-ttc-fonts）を入れられませんでした。日本語のラベルは、書き出した画像で文字化けします。" >&2
  $pm clean all >/dev/null 2>&1 || true
fi

if [ ! -x /opt/drawio/drawio ]; then warn "/opt/drawio/drawio が見つからない"; fi
# 本体が読めない共有ライブラリが残っていれば知らせる（パッケージの依存の書き漏れ。入れたまま続ける）
if command -v ldd >/dev/null 2>&1; then
  missing="$(ldd /opt/drawio/drawio 2>/dev/null | awk '/not found/ { print $1 }' | tr '\n' ' ')"
  if [ -n "$missing" ]; then
    echo "sacty: 警告：draw.io の CLI が読めないライブラリがあります（${missing% }）。drawio は起動しません。" >&2
  fi
fi
# Chromium のサンドボックスの補助（setuid root）は使わない。コンテナは no-new-privileges で動かすので効かず、
# 包むスクリプトが --no-sandbox で起動する。使わない setuid のファイルを残さない
if [ -f /opt/drawio/chrome-sandbox ]; then chmod 0755 /opt/drawio/chrome-sandbox; fi
# 仮想の画面のソケットの置き場（node ユーザーの Xvfb が使う）
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
# PATH の先頭（/opt/sacty/bin）に、画面の無いコンテナで動かすための包むスクリプトを drawio の名前で置く
mkdir -p /opt/sacty/bin
ln -sf /opt/sacty/lib/drawio-shim.cjs /opt/sacty/bin/drawio
echo "sacty: draw.io の CLI（$VERSION）を入れました。"
