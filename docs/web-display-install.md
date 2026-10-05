# KK Code 1.0.11 Web 显示补丁安装

此包只替换 `src/web` 下的静态网页资源，适用于已升级到 **1.0.11** 的网关或本机 Web。npm latest、CLI运行时、Android10018、网关账号、数据库、SSO及签名身份保持原状。

从[官方Web显示补丁Release](https://github.com/kkelly-offical/kkcode/releases/tag/web-1.0.11-display.1)下载 `kkcode-web-1.0.11-display.1.tar.gz` 和同名 `.sha256`，核对校验和后解压。在可写的1.0.11安装目录上运行：

```sh
sha256sum -c kkcode-web-1.0.11-display.1.tar.gz.sha256
mkdir -p /path/to/extracted-patch
tar -xzf kkcode-web-1.0.11-display.1.tar.gz -C /path/to/extracted-patch
node /path/to/extracted-patch/apply.mjs --target /path/to/kkcode
```

`--target` 是包含 `package.json` 和 `src/web` 的KK Code安装目录，不是用户配置目录。全局npm安装通常位于 `npm root -g` 输出目录下的 `@kkelly-offical/kkcode`；容器内通常为 `/app`。使用原部署账户执行，保留现有目录权限。安装器拒绝错误基础版本、损坏资源、符号链接和未识别的网页修改。

安装器先校验资源并输出备份路径，再写入新哈希资源，最后原子切换入口。旧哈希资源保留，已经打开的页面仍可加载其资源。现有网关进程不必重启，浏览器刷新后生效；反向代理若缓存HTML入口，请仅刷新该入口缓存。安装不会改变正在运行的对话。

成功后，外观设置可调整文字大小和阅读宽度；设置页可看到 `Web · 1.0.11-display.1`。也可核对静态 `/display-patch.json`。安装器重复运行会先校验并提示已经安装。

如需回退，使用安装时打印的备份路径：

```sh
node /path/to/extracted-patch/apply.mjs --target /path/to/kkcode --rollback /path/to/kkcode/src/.kkcode-web-backup-xxxxxx
```

回退恢复原1.0.11网页入口，保留无害的哈希资源以免打断已经打开的标签页。保留备份；若安装被打断或存在锁文件，先确认没有其他安装器运行并检查已输出的备份，不盲目覆盖未知改动。

若基础网关较旧，也可直接从 `web-1.0.11-display.1` 源码标签构建网关，得到1.0.11后端与此次显示补丁。容器部署建议在原1.0.11基础镜像上以原运行用户身份复制此包的 `src/web/` 构建新的本地镜像，并沿用原Compose环境、卷、账号及SSO配置；不要修改临时容器后把它当成持久升级。本补丁没有发布公共网关镜像，也不会自动升级其他生产网关。

对应源代码与实际验证记录见官方仓库的 `web-1.0.11-display.1` 标签及 `docs/web-display-1.0.11.md`。本包采用与项目相同的GPL-3.0许可证。
