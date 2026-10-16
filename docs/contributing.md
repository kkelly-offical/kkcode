# 开发与验证

[文档导航](README.md) · 公开版本与源码目标见[版本状态](versions.md)。

## 小步修改

先在[Issues](https://github.com/kkelly-offical/kkcode/issues)确认问题和验收范围，再建立
独立分支。缺陷、能力边界和未覆盖的测试分开记录；不要把维护文档当成已修复运行时。
保持现有CLI/headless契约、Web/Android布局及权限边界。

所有改动执行必备检查：

```sh
npm ci
npm run version:check
npm run lint
npm run typecheck
npm run typecheck:web
npm test
```

Web或Device/API契约改动必须再运行 `npm run test:web`；它已包含Web构建，不重复执行
`npm run build:web`。其他改动仍执行 `npm run build:web`。Web套件只保留真实Device/API、
隔离UI契约、安全、响应式和状态恢复等仍有独立保护作用的浏览器检查。

按改动补专项：`npm run test:e2e`、`npm run test:compatibility`；发布候选执行
`npm run release:verify`。完整源码测试命令不保证存在于全局npm安装包中。
普通Node套件中的浏览器专项可按既有条件skip；Web必跑套件须在Chromium可用环境完整执行。
本机通过不能代替所需的平台／真实模型验收；未执行、skip及原因须如实记录，不写成通过，
也不新增skip换取绿灯。

## 版本准备与发行分开

根包、四个私有工作区和锁文件必须同版本；CLI／Web从根包读取，Android版本名与之
一致，公开版本码递增并保留项目证书。当前公开版本与源码目标只在[版本状态](versions.md)维护，
不把旧任务中的临时许可当作新发行授权。
正式发行另行批准，使用经过验收的不可变产物；既有tag和npm版本不覆盖。

main受PR和审核约束。同时检查传统branch protection与repository rulesets；
某个接口404不代表没有保护，不能默认使用管理员旁路或自行授予批准。

## 文档约定

- README保持简短：产品特色、快速开始、文档入口，不塞历史发布流水账。
- 当前指南按主题组织，指向统一的[版本状态](versions.md)和[能力边界](capabilities.md)。
- 历史版本、评测和失败记录保留原始身份，在[历史导航](history.md)查阅。
- 新的当前指南须加入npm文档清单；测试检查包内本地链接，源码专用入口注明范围。
- 新功能／行为变化同时更新用法、约束和回归。示例只用占位值，不提交真实凭据。

## 真实模型及外部操作

模型调用、企业账号、测试仓库和生产环境各自需要授权。历史本机评测窗口不能沿用；
独立授权的冻结候选评测与本轮工程修复分开记账，不复用旧聊天密钥或无限续跑。
修订评测定义应保留旧结果和新指纹，不读取封存答案调参。
公开脱敏证据即可，不上传私密配置、SSO/SSH凭据、签名密钥或用户会话正文。
