#!/usr/bin/env bash
# 真实终端验收工具（0.6.0）。
#
# 存在的理由：单元测试与伪终端测试能验证 SGR 解码、Unicode 布局、选区计算，
# 但证明不了「GUI 终端里实际长什么样」——颜色搭配、浮层布局、中英混排、
# 窄终端降级、无色模式的可辨认度，这些只有人眼（或截图）能判断。
#
# 用法：
#   scripts/tty-acceptance.sh shot <名字> <列>x<行> <命令...>
#   scripts/tty-acceptance.sh key  <按键序列>      # 向当前终端发送按键
#   scripts/tty-acceptance.sh stop
#
# 产物落在 $ACCEPT_DIR（默认 /tmp/kkcode-tty-acceptance）。
set -uo pipefail

DISPLAY_NUM="${TTY_DISPLAY:-:99}"
ACCEPT_DIR="${ACCEPT_DIR:-/tmp/kkcode-tty-acceptance}"
FONT="${TTY_FONT:-DejaVu Sans Mono}"
FONT_SIZE="${TTY_FONT_SIZE:-12}"
export DISPLAY="$DISPLAY_NUM"

mkdir -p "$ACCEPT_DIR"

# 窗口管理器是必需的，不是可选的：没有 WM 时窗口拿不到输入焦点，
# xdotool 的按键会被静默丢弃 —— 命令返回 0、截图看起来正常、按键没生效。
# 这个脚本此前只起 Xvfb，能跑通只是因为环境里恰好残留着一个 openbox 进程。
ensure_wm() {
  pgrep -x openbox >/dev/null 2>&1 && return 0
  if ! command -v openbox >/dev/null 2>&1; then
    echo "缺少 openbox：没有窗口管理器时 xdotool 按键会静默失败" >&2
    echo "  安装：apt-get install -y openbox" >&2
    return 1
  fi
  openbox --sm-disable >"$ACCEPT_DIR/openbox.log" 2>&1 &
  for _ in $(seq 1 20); do pgrep -x openbox >/dev/null 2>&1 && { sleep 0.5; return 0; }; sleep 0.25; done
  echo "openbox 起不来" >&2
  return 1
}

ensure_x() {
  if ! xdpyinfo >/dev/null 2>&1; then
    Xvfb "$DISPLAY_NUM" -screen 0 "${TTY_SCREEN:-1400x900x24}" >"$ACCEPT_DIR/xvfb.log" 2>&1 &
    local up=""
    for _ in $(seq 1 40); do xdpyinfo >/dev/null 2>&1 && { up=1; break; }; sleep 0.25; done
    if [ -z "$up" ]; then
      echo "X display $DISPLAY_NUM 起不来" >&2
      return 1
    fi
  fi
  ensure_wm
}

case "${1:-}" in
  shot)
    name="$2"; geom="$3"; shift 3
    ensure_x || exit 1
    # 按进程名而非命令行匹配：`pkill -f "xterm -geometry"` 会匹配到任何
    # 命令行里含这段文字的进程，包括调用方自己的 shell（实测踩过）。
    pkill -x xterm 2>/dev/null; sleep 0.5
    # 保持终端存活，便于后续发按键；命令结束后挂住而不是关窗
    xterm -geometry "$geom" -fa "$FONT" -fs "$FONT_SIZE" \
      -bg "${TTY_BG:-#0b0b0b}" -fg "${TTY_FG:-#f5f7fa}" \
      -e bash -c "$*; exec sleep ${TTY_HOLD:-120}" &
    sleep "${TTY_SETTLE:-5}"
    import -window root "$ACCEPT_DIR/$name.png"
    echo "$ACCEPT_DIR/$name.png"
    ;;
  key)
    ensure_x || exit 1
    win=$(xdotool search --class XTerm | head -1)
    [ -n "$win" ] || { echo "找不到终端窗口" >&2; exit 1; }
    xdotool windowactivate --sync "$win" 2>/dev/null
    shift
    for k in "$@"; do xdotool key --window "$win" --clearmodifiers "$k"; sleep 0.2; done
    ;;
  type)
    ensure_x || exit 1
    win=$(xdotool search --class XTerm | head -1)
    xdotool type --window "$win" --delay 30 "$2"
    ;;
  recapture)
    ensure_x || exit 1
    sleep "${TTY_SETTLE:-2}"
    import -window root "$ACCEPT_DIR/$2.png"
    echo "$ACCEPT_DIR/$2.png"
    ;;
  stop)
    pkill -x xterm 2>/dev/null
    pkill -x openbox 2>/dev/null
    pkill Xvfb 2>/dev/null
    echo "已停止"
    ;;
  *)
    sed -n '1,20p' "$0"
    exit 1
    ;;
esac
