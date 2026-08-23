# Agent Note: Web 客户端服务权威信任

Status: implemented

[English](2026-08-23-web-client-serving-authorities.md) | 中文

## 问题

web 客户端仅凭浏览器地址栏决定 settings 平面的信任：`connection.isLoopback = isLoopbackHostname(pageLocation.hostname)` 驱动每个 settings 消费方的 `'host'`/`'memory'` 持久化选择。经回环改写代理提供页面的部署（文档化的 Caddy 模式：前端在请求到达后端前把 Host/Origin 改写为 127.0.0.1）呈现的是非回环页面权威，于是客户端把 settings 镜像切换为 `'memory'`，模型设置页以「settings are unavailable in this browser」失败，尽管服务端栅栏接受该改写后的请求。

## 决策

本 Agent Note 扩展 [api 浏览器信任边界 Agent Note](2026-07-28-api-browser-trust-boundary.zh.md)；栅栏本身不变（`trustedHosts` 仍是防重绑栅栏而非认证，特权方法集仍钉在回环）。

- host 把部署的非回环服务权威——client-connection 校验过的 `trustedHosts` 剔除回环条目（回环在客户端无需 wire 条目即视为第一方）——发布进 boot wire，作为 `window.__DSH_BOOT__.trustedAuthorities`（client-modules 的 `publishTrustedAuthorities`；图 `rev` 覆盖 `[entries, trustedAuthorities]`，因此变更后的发布会重组 wire 并恰好通知一次图监听方）。
- 客户端把 `connection.isLoopback` 更名为 `connection.isServingAuthority`：页面不存在（非浏览器）、其 hostname 是回环、或其权威按宿主栅栏的比较语义匹配某条 wire 条目（不带端口的条目匹配任意端口上的该 hostname；`host:port` 匹配该精确权威，两侧均经 WHATWG 归一化）时为 true。
- settings 平面（`'host'`/`'memory'` 持久化、本地文档操作、产物文件打开文件夹按钮）以新字段为准。没有该字段的旧 HTML 解析为空列表；旧客户端忽略新增的 wire 字段。

## 曾考虑的替代方案

- **保留 `isLoopback`，再为 wire 列表加一个布尔字段**——否决：每个消费方都要把两个布尔合并成同一个判定；一个字段命名最终答案，且更名是穷尽的，源码中不再同时保留两者。
- **让浏览器探测服务器确认自己的权威**——否决：信任判定在插件 apply 时消费，早于任何传输往返；探测还要从运行中的服务器重新推导栅栏列表，而不是用栅栏真正把关的那份已定配置。
- **把列表放在客户端侧配置里而不是 host wire 里**——否决：host 的 `trustedHosts` 已是权威列表；第二份客户端侧声明会与实际把关请求的栅栏脱节。

## 结果

- 位于回环改写代理之后的部署，只要其页面权威已声明在 `trustedHosts` 中，就能向其浏览器提供 settings 平面；直接的远程浏览器（权威不在列表中）保持 `'memory'` 镜像，行为不变。
- wire 新增的字段两个方向都兼容：旧 HTML 得到 `[]`，旧客户端忽略它，畸形的字段让启动明确失败。
- 服务端语义没有移动：`trustedHosts` 仍是可达性策略而非认证，特权方法集仍仅限回环。
