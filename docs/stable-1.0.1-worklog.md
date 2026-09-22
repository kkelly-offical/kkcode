# 1.0.1 stable completion ledger

Baseline: public `1.0.1-preview.2`, main `3511782`.
The user authorized a stable `1.0.1` release after these additions and acceptance:

- [ ] Android GitHub update source: check/channel selection, bounded download,
  package/hash/certificate verification, explicit Android install consent and
  retry/cancellation handling. Enterprise update management is deferred.
- [ ] Dedicated local Ubuntu VM connected to `https://coding.internal.zzheng.cn`;
  user completes the device-grant browser approval. Keep the remote hub in a
  visible foreground terminal, not an auto-start exposure service.
- [ ] Web and Android pixel visual theme, inspired by the existing Jianwei case
  workspace: monochrome surfaces, restrained pixel texture, crisp borders and
  stepped corners. Preserve existing control positions, sizes and functionality;
  keep semantic diff/status colors and accessibility.
- [ ] Stable version `1.0.1` across workspaces; Android code `10004`, existing
  release certificate; signed APK/update manifest, current Web container build.
- [ ] Full local/browser/Android/network/package/security and platform CI gates,
  then stable npm/GitHub publication. Do not describe pending work as released.

Only the KK Code checkout and explicitly owned VM/lab resources are modified.
The reference lawyer-workspace source and existing unrelated VMs remain unchanged.
Production gateway deployment is not modified without a separate explicit request.
