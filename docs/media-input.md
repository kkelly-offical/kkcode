# 图片、音频与视频输入

[文档导航](README.md) · 适用源码：1.0.5；[版本与升级](versions.md)。

附件必须同时满足：文件格式有效、客户端能编码该协议、目标模型支持该输入。
“已暂存/已附加”只表示附件在当前草稿中，不表示模型已经收到或理解它。

## 支持矩阵

| 入口／协议 | 图片 | 音频 | 视频 |
| --- | --- | --- | --- |
| CLI `Ctrl+V`、`/paste [问题]` | PNG/JPEG/GIF/WebP 截图或复制的文件 | WAV、MP3 | MP4、MOV、WebM、MPEG |
| Web／Android 上传 | 同上，单个最多 4 MiB | WAV、MP3，单个最多 4 MiB | 同左大小限制，格式同 CLI |
| OpenAI Chat 兼容请求 | `image_url` | `input_audio`，base64 + wav/mp3 | `video_url` 扩展，base64 Data URL |
| OpenAI Responses | `input_image`，经格式和能力验证 | 明确拒绝 | 明确拒绝 |
| Anthropic Messages | 原生 `image` | 明确拒绝 | 明确拒绝 |
| Ollama 当前适配器 | 沿用既有图片路径 | 明确拒绝 | 明确拒绝 |

`video_url` 是部分 OpenAI **兼容服务**提供的扩展，不能据此推断 OpenAI
原生端点或所有兼容网关都支持视频。模型的视觉理解是否包含视频中的声音，
也取决于供应商。客户端不进行隐式转码、语音识别或视频抽帧。

协议依据：[Google 兼容接口音频输入](https://ai.google.dev/gemini-api/docs/openai#audio_understanding)、
[阿里云兼容 Chat 输入类型](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)、
[Anthropic 图像输入](https://platform.claude.com/docs/en/build-with-claude/vision)。
供应商的大小、时长、编码和计费限制仍然适用，可能比 KK Code 更严格。

## 模型配置

先配置自己的 Base URL 和密钥环境变量，再用 `/model refresh` 读取目录。
目录的 `input_modalities`、`capabilities` 等字段优先于名称推断。
如目录不提供能力，可在**确认供应商支持以后**显式设置：

```yaml
provider:
  default: company
  company:
    type: openai-compatible
    base_url: https://models.example.com/v1
    api_key_env: COMPANY_MODEL_KEY
    default_model: your-multimodal-model
  model_capabilities:
    your-multimodal-model:
      image: true
      audio: true
      video: true
      tools: true
```

能力配置不能给不支持音视频的协议“增加能力”。未知音视频能力会拒绝附加，
提示发现或配置能力；不再先报“成功”再换成文字占位。新输入在请求前拒绝；
切换到不兼容模型后的历史媒体使用明确的占位说明，避免整个历史永久不可继续。
推理请求与前置 token 计数使用同一能力检查；例如含音视频的历史切换到
Anthropic 后，`count_tokens` 也只收到占位文本，不会提前编码失败。
选择器中 `?` 表示名称推断，不是实测结论。没有对所有目录模型进行付费推理探测。

## 剪贴板与文件边界

- Windows：截图沿用 PowerShell 图像读取；复制文件读取原生 FileDropList。
- macOS：截图使用 pngpaste／osascript；复制文件读取原生文件引用。
- Linux：Wayland `wl-paste`，回退 X11 `xclip`；支持音视频 MIME 和本地 URI 列表。
- 一次复制一个文件；多个文件、远程文件 URL、UNC 网络共享、非普通文件被拒绝。
- CLI 单个媒体上限 20 MiB；图片完整解码、最多 24M 像素，必要时旋转/缩放到 2048 范围，动画取首帧；单请求最多保留最近 16 张。音视频仍使用格式签名检查而不是完整解码器，损坏的音视频仍可能被供应商拒绝。
- SSH 终端中的系统剪贴板属于运行 KK Code 的电脑；不会隐式读取用户手机或
  笔记本的剪贴板。远程使用 Web／Android 的附件上传入口。
- Web／Android 每回合最多 8 个附件，单会话暂存 16 MiB、设备 64 MiB、256 项，
  默认 24 小时过期。暂存与持久化会话历史不同，发送后的副本遵循设备历史保留策略。
- 凭据文件不能上传；附件路径由设备生成，不使用客户端文件名作为磁盘路径。

## 验证与排错

### SVG、工具返回和历史恢复

SVG 默认通过 `read` 当 XML 源码读取，后续可直接 `edit`；`view: "image"`
才生成受限的静态 PNG 预览。模型原生图片请求不再使用 SVG 字节。
渲染不加载网络/磁盘外部资源，也不支持脚本、foreignObject、嵌入图像或外部样式。
旧历史中的合法 SVG 在请求副本中转换为 PNG，损坏/危险媒体换成说明文字；原历史保留。
Web/Android 图片行按需调用经鉴权的 `media.preview`，只接受本会话中的 message/index，
不接收客户端任意路径，也不把 SVG 作为 HTML 注入网页。

MCP/插件图片和结构化结果走共同的工具结果通道；每次工具结果最多 8 个媒体块。
资源链接只显示引用，不隐式下载。新无效附件在请求前明确报错，旧无效附件不会
让之后的纯文本消息永久失败。Responses的额外协议边界见[适配器说明](responses-api.md)。

`media-clipboard` 测试用可控的系统命令替身覆盖三个 OS；`media-pipeline` 用
本地 HTTP 服务逐字检查流式/非流式请求体；`device-attachments` 验证远程暂存、
格式、配额及会话隔离。它们不等同于所有真实模型或所有桌面剪贴板策略验收。

历史1.0.2验收还通过真实HTTPS Relay将WAV/MP4字节送达可控兼容模型端点，核对
字节哈希、历史二进制脱敏、拒绝后的草稿保留，并继续切换到 Anthropic 对话。
这证明传输与编码链路，不冒充真实音视频模型的理解效果测试；真实 K3 另做了
有上限的文本推理验收。

如果提示不支持输入：检查协议、模型目录能力和文件格式，不要盲目把所有能力
改成 `true`。如果显示剪贴板为空：检查桌面剪贴板程序和当前是否为 SSH 会话。
