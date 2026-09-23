# 内核与远程 SDK（1.0.4 Preview）

Node `>=22.12`，安装包的公开入口保持不变：

```ts
import { createKernel, DeviceClient } from '@kkelly-offical/kkcode/sdk';

const kernel = await createKernel({ cwd: '/absolute/workspace', boot: false });
try {
  // 具体模型、工作区信任及权限按宿主配置，不在此绕过。
  const result = await kernel.executeTurn({ sessionId: 'my-session', prompt: '检查项目结构' });
  console.log(result.reply);
} finally {
  await kernel.shutdown();
}

const client = new DeviceClient({ url: 'https://gateway.example.com', deviceId: 'device-id', token: accessToken });
const sessions = await client.call('sessions.list', {});
await client.call('sessions.delete', { sessionId: sessions[0].id, confirmed: true });
```

上例删除是显式示例，实际 UI 必须先让用户确认。SDK 不隐式获取 control lease；
start/configure/rewind 等需要 `control.acquire`，完成后显式 `control.release`。

`createKernel`、主要内核接口及全部 DeviceMethods 都有 `.d.mts`。严格外部 TS
消费者不需要 `allowJs` 或跳过库检查才能导入；旧 `request<T>(method, params)`
仍可用，新的 `call()` 校验方法名及对应参数。复杂扩展载荷仍用 unknown/记录类型，
不要把类型声明当成网络输入验证；设备协议仍负责运行时校验和授权。

浏览器只需传输层时，使用 `@kkelly-offical/kkcode/sdk/client`，避免打包 Node 内核。

```ts
const controller = new AbortController();
await client.stream('session-id', {
  after: snapshot.eventCursor,
  signal: controller.signal,
  onEvent: event => applyEvent(event),
  onMeta: state => applyState(state),
  onGap: async () => reloadCanonicalSnapshot()
});
```

stream 消费一条连接；宿主决定重连/退回 `events()` 轮询。切换设备/卸载界面时
abort，reader 会被取消释放；401 刷新复用已有单飞凭据轮转。replay.gap 要重新加载
规范快照，不能把缺失的流片段当完整历史。Web 与 SDK 共用此实现。

Node 通过 SSH 本地转发连接时，目标机仍严格校验 Host。浏览器兼容 fetch 不允许
自定义 Host，可通过 SDK `fetch` 注入基于 Node HTTP 的转发传输；不要为迁就隧道
关闭服务端 Host/Origin 校验。Web 产品本轮不提供 SSH。

`kernel.diagnostics.inspectPrompt(sessionId)` 只返回最近请求的提示来源、指纹和预算
元数据。SDK 宿主负责生命周期、并发会话控制、用户交互和输出；内核不渲染终端界面。
