# KK Code 品牌素材

用户提供并授权用于 GitHub 产品展示的两张 Image 概念图：

- `kkcode-product-banner.jpg`：原始 16:9 产品印象图，README 主图。
- `kkcode-android-original.jpg`：原始 1:1 Android 品牌图，保留不覆盖。
- `kkcode-android-icon-v2.png`：由内置 imagegen 工具基于原图整理的 Android
  图标母版；保留对讲机、地球、金色轨道和 KC，去掉缩小后不可读的屏幕小字与
  预烘焙圆角边框。生成模型的具体版本未由当前工具明确提供，不标注 Image 2.5。

Android 使用同一 PNG 的仓库内副本
`android/app/src/main/res/drawable-nodpi/kkcode_launcher_art.png`；自适应图标 XML
预留裁切安全边距，圆形／圆角方形由 Launcher 决定。不会将横幅或装饰图插进
对话区，也不移动现有按键。这里的概念图不是实际 UI 截图，不代表模型／设备能力。

## 生成记录

模式：内置 imagegen，单次 edit，输入为用户第一张图片；没有使用外部 CLI
或把模型 API key 发送给图像服务。用户原图和工具生成图保留各自原始文件。

最终提示词：

```text
Use case: precise-object-edit. Asset type: production Android launcher icon master, square 1:1. Input image 1 is the edit target and exact brand reference. Refine it for legibility at small app-icon sizes while keeping its recognizable black radio/walkie-talkie, blue Earth, warm gold orbit, and gold brush-letter KC identity. Preserve the cinematic deep navy/black and amber-gold materials and mood. Keep the radio, antenna and full KC lettering together within the central 66% safe region so Android circle and squircle masks never cut off those important elements. Simplify excessive tiny texture and remove the unreadable CONNECT BUILD TOGETHER micro-slogan from the small radio screen; retain a clean amber waveform on that screen. The only visible lettering is exactly 'KC'. Retain a restrained gold orbital sweep and tiny star accents. Render a full-bleed square dark navy background all the way to the edges, NO baked rounded-rectangle icon frame, NO device mockup, NO border, NO caption outside the icon, NO extra objects, NO new logo. The result should be a polished practical adaptation of the provided artwork, not a different brand. One icon only.
```

验收时以实际 Launcher／系统安装界面渲染为准：生成图片并未完全按提示保留
足够安全边距，因此通过资源 XML inset 修正裁切，而不声称模型输出天然合规。
