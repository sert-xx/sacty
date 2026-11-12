#!/bin/sh
# ビルドのキャッシュを使うように設定して、引数のコマンドを実行する（Dockerfile から root で実行する）。
# キャッシュは、Dockerfile の RUN が BuildKit の cache マウントで /var/cache/sacty-build に渡す（イメージの層には残らない）。
# マウントが無ければ、何も設定せずに実行する（これまでどおり、毎回取得する）。
# - apt-get：取得した .deb を $cache/apt に置く（APT_CONFIG の Dir::Cache::Archives）。元のイメージが APT_CONFIG を
#   設定していれば、そのファイルを #include で読み込んでから足す（プロキシなどの設定を失わないように）。Debian・Ubuntu の公式のイメージの
#   docker-clean は /var/cache/apt/archives の .deb を消すが、こちらには触れない。パッケージの一覧（/var/lib/apt/lists）は
#   置かない（毎回 apt-get update で取り、古い一覧で入れない）。apt-get は置いた .deb を、一覧のハッシュと合うときだけ使う
# - draw.io・セキュリティの道具の取得物：$cache/downloads（SACTY_DOWNLOAD_CACHE）。各スクリプトが、固定したハッシュと
#   合うときだけ使う
# 置いてから 30 日を過ぎた .deb は消す（版が上がって使わなくなったものが溜まり続けないように。使うものは取り直す）。
# 置いた日時は ctime で見る（apt-get は .deb の mtime を配布元の日時にするので、mtime では置いたばかりのものも消える）
set -u

# 場所はテストのときだけ SACTY_BUILD_CACHE_DIR で変える
cache="${SACTY_BUILD_CACHE_DIR:-/var/cache/sacty-build}"
if [ -d "$cache" ] && [ -w "$cache" ]; then
  mkdir -p "$cache/apt/partial" "$cache/downloads"
  find "$cache/apt" -maxdepth 1 -name '*.deb' -type f -ctime +30 -exec rm -f {} + 2>/dev/null || true
  {
    if [ -n "${APT_CONFIG:-}" ] && [ "$APT_CONFIG" != "$cache/apt.conf" ] && [ -f "$APT_CONFIG" ]; then
      printf '#include "%s";\n' "$APT_CONFIG"
    fi
    printf 'Dir::Cache::Archives "%s/apt/";\n' "$cache"
  } >"$cache/apt.conf"
  APT_CONFIG="$cache/apt.conf"
  SACTY_DOWNLOAD_CACHE="$cache/downloads"
  export APT_CONFIG SACTY_DOWNLOAD_CACHE
fi
exec "$@"
