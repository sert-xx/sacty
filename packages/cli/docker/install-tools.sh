#!/bin/sh
# エージェントの作業で使う CLI を、イメージに足す（Dockerfile から root で実行する）。
# 入れるのは、元のイメージに無いコマンドだけ（言語ごとのイメージの元に入っているものは、そのまま使う）。
# パッケージは、元のイメージにあるパッケージの管理のコマンド（apt-get・dnf・microdnf・yum）で、OS の配布元
# （元のイメージに設定してあるミラー）から入れる。配布元のセキュリティの更新は、イメージを作り直すと入る。
# パッケージのミラーに届かない・パッケージが無い（RHEL 系で EPEL が無いときの ripgrep など）ときは、警告して続ける
# （イメージは作れる。無いコマンドは、エージェントが別の方法で代える）。
set -u

# 「コマンド:Debian・Ubuntu 系のパッケージ:RHEL 系のパッケージ」。RHEL 系のパッケージが空なら、RHEL 系では入れない
TOOLS="
jq:jq:jq
rg:ripgrep:ripgrep
fd:fd-find:fd-find
tree:tree:tree
file:file:file
less:less:less
curl:curl:curl
zip:zip:zip
unzip:unzip:unzip
xz:xz-utils:xz
bzip2:bzip2:bzip2
patch:patch:patch
diff:diffutils:diffutils
find:findutils:findutils
make:make:make
ps:procps:procps-ng
sqlite3:sqlite3:sqlite
python3:python3:python3
shellcheck:shellcheck:ShellCheck
"

if command -v apt-get >/dev/null 2>&1; then family=deb
elif command -v dnf >/dev/null 2>&1; then family=rpm; pm=dnf
elif command -v microdnf >/dev/null 2>&1; then family=rpm; pm=microdnf
elif command -v yum >/dev/null 2>&1; then family=rpm; pm=yum
else
  echo "sacty: 警告：パッケージの管理のコマンド（apt-get・dnf・microdnf・yum）が見つからないので、作業用の CLI（jq・rg など）を入れません。" >&2
  exit 0
fi

# Debian・Ubuntu 系の fd は fdfind という名前で入る
has() {
  command -v "$1" >/dev/null 2>&1 || { [ "$1" = fd ] && command -v fdfind >/dev/null 2>&1; }
}

packages=""
for entry in $TOOLS; do
  cmd="${entry%%:*}"
  rest="${entry#*:}"
  if [ "$family" = deb ]; then pkg="${rest%%:*}"; else pkg="${rest#*:}"; fi
  if [ -n "$pkg" ] && ! has "$cmd"; then packages="$packages $pkg"; fi
done
# curl が https の取得先を確かめるための証明書（Debian・Ubuntu 系の slim のイメージには無い）
if [ "$family" = deb ] && [ ! -e /etc/ssl/certs/ca-certificates.crt ]; then packages="$packages ca-certificates"; fi

if [ -n "$packages" ]; then
  echo "sacty: 作業用の CLI を入れます：$packages"
  if [ "$family" = deb ]; then
    if apt-get update; then
      # まとめて入れ、だめなら1つずつ（無いパッケージがあっても、ほかは入れる）
      # shellcheck disable=SC2086
      if ! apt-get install -y --no-install-recommends $packages; then
        for pkg in $packages; do apt-get install -y --no-install-recommends "$pkg" || true; done
      fi
    fi
    rm -rf /var/lib/apt/lists/*
  else
    opts="-y"
    [ "$pm" = microdnf ] || opts="-y --setopt=install_weak_deps=False"
    # shellcheck disable=SC2086
    if ! $pm install $opts $packages; then
      for pkg in $packages; do $pm install $opts "$pkg" || true; done
    fi
    $pm clean all >/dev/null 2>&1 || true
  fi
fi

# Debian・Ubuntu 系の fdfind を、ほかの環境と同じ fd の名前でも使えるようにする
if ! command -v fd >/dev/null 2>&1 && command -v fdfind >/dev/null 2>&1; then
  ln -s "$(command -v fdfind)" /usr/local/bin/fd
fi

missing=""
for entry in $TOOLS; do
  cmd="${entry%%:*}"
  has "$cmd" || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
  echo "sacty: 警告：作業用の CLI のうち、次のコマンドを入れられませんでした（パッケージのミラーに届くか、パッケージがあるかを確かめてください。RHEL 系では EPEL にしか無いものがあります）：$missing" >&2
fi
exit 0
