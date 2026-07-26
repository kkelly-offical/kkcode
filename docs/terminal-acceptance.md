# 真实终端验收 / Real-terminal acceptance

## 为什么需要它

单元测试与伪终端测试能验证 SGR 解码、Unicode 宽度、选区算术、光标坐标。
它们证明不了的是**「屏幕上实际长什么样」**：配色搭配、浮层布局、中英混排、
窄终端降级、无色模式下还认不认得出选中项。

这不是理论顾虑。0.6.0 发布后第一次在真实终端里跑，第一屏就看出状态栏把
`PERMISSION` 截断了——为了给同一版新增的 token 数腾位置。被牺牲的恰好是
「agent 能不能不问就改文件」这个信号，而 1133 条单元测试没有一条会红，因为
`renderStatusBar` 直读 `process.stdout.columns`，测试进程里它恒为 undefined，
所有断言走的都是最宽的那套布局。

## 工具

`scripts/tty-acceptance.sh`。依赖：

```bash
apt-get install -y xvfb openbox xterm xdotool xclip imagemagick fonts-noto-cjk
```

**窗口管理器不是可选项。** 没有它，Xvfb 下的窗口拿不到输入焦点，
`xdotool key` 会静静地什么也不做（只在 stderr 留下一句
`XGetInputFocus returned the focused window of 1`），你会以为按键送到了。

```bash
export DISPLAY=:99
Xvfb :99 -screen 0 1400x900x24 &
openbox --sm-disable &

scripts/tty-acceptance.sh shot 01-start 110x32 "node src/index.mjs"
scripts/tty-acceptance.sh key y Return          # 应答工作区信任
scripts/tty-acceptance.sh type "写一个 js 闭包例子"
scripts/tty-acceptance.sh key Return
scripts/tty-acceptance.sh recapture 02-reply
```

截图落在 `/tmp/kkcode-tty-acceptance/`。字体用 `DejaVu Sans Mono`：
CJK 字体（如 Noto Sans Mono CJK）会把拉丁字符也按全角渲染，代码看起来像
`c o n s t`，那是终端字体的问题，不是渲染层的。

## 检查项

每次触及渲染层的改动都应跑一遍：

| 项 | 看什么 |
|---|---|
| 状态栏 | 各宽度下不溢出；`PERMISSION` 与 `CONTEXT` 永远在 |
| markdown | 标题层级色差、粗斜删、行内代码、水平线、列表、引用 |
| 语法高亮 | 关键字/字符串/数字/注释分色；**去掉颜色后能逐字还原源码** |
| 浮层 | 边框四边对齐；`NO_COLOR=1` 下靠 `▸` 仍能看出选中项 |
| 窄终端 | 60/70/88 列下不塌、不横向溢出 |
| 中英混排 | 对齐正确、光标落点正确 |
| 面板通道 | `/help` `/status` `/board` 折叠成一行，不刷屏 |

## 这套链路覆盖不到的

- **Windows Terminal + 微软拼音**、**macOS Terminal/iTerm2 + 系统输入法**——
  验收矩阵三行里的两行。开 Linux 虚拟机也解决不了，需要真机。
- 桌面剪贴板策略、OSC 52 在各终端的差异。
- 审美判断。截图能看，好不好看还是人说了算。

`docs/terminal-experience-0.3.3.md` 的手工验收矩阵仍然有效，本文档只补上了
其中 Linux 那一行的自动化路径。
