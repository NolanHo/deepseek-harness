# Agent Note: Remote stream mux negotiates permessage-deflate

Status: implemented

[English](2026-08-29-remote-mux-permessage-deflate.md) | 中文

> Scope: the Gateway's Remote stream WebSocket (`/api/remote.mux`). One server option, config-gated.

## 问题

冷打开事件密集的会话时，整个首窗历史以一条 `opened` journal 帧经 WebSocket 传输（最大会话实测 1.2-1.4 MB——其中约 70% 是流式 chunk 事件）。传输层无法压缩它：RFC 7692 的 permessage-deflate 未启用，帧字节原样过网。环回部署对此无感；慢速反代路径上同样的兆级流量主导打开延迟，而代理响应上的 HTTP gzip 到不了 WebSocket 载荷。

## 决策

`RemoteStreamMuxServer` 接受 `perMessageDeflate` 构造参数，接到新增的 `Config.websocketPerMessageDeflate`（默认 false，本部署经 profile patch 启用）。选项为 `perMessageDeflate: { threshold: 1024 }`：journal `opened` 帧（整页历史窗口，恒高于阈值）压缩数倍；实时逐事件帧保持原样——流式路径无 deflate 延迟。浏览器在 WebSocket 握手中自动协商该扩展；不提供扩展的客户端（或 `perMessageDeflate: false` 的 ws 客户端）回落到普通帧，客户端零改动。压缩对协议透明：mux 的帧处理不变，只有传输编码变化。

本决策刻意不解决的：客户端解码与折叠窗口的成本（8.5k 事件）——冷打开的渲染段不变。若启用后快速链路上的打开仍然慢，剩下的杠杆是窗口内容缩减，不是传输。

## 备选方案

- **在 mux 协议内压缩帧载荷**（逐条 JSON gzip）：重复 RFC 7692 已为两端标准化的能力，且每个客户端都要自实现解码。
- **无条件启用 permessage-deflate**：开关保持与 webserver gzip 一致的配置门控——环回快速链路的部署无收益，也不必承担 zlib 窗口。
- **改为缩减窗口内容**（页读取跳过 chunk 事件）：对渲染段也是更大杠杆，但触碰页读取与折叠的回放契约；若传输压缩后仍不够，作为后续手段保留。
## 验证

`stream-server.host.spec.ts`：协商客户端在两端 `socket.extensions` 看到 `permessage-deflate` 且整页帧往返成功；显式关闭的客户端回落普通帧并同样往返。配置 schema 测试钉住默认关闭与显式开启。

## 后果

- 慢速路径上冷打开窗口的线上体积降数倍；实时帧延迟不变（低于阈值跳过 deflate）。
- 该扩展每连接消耗一个 zlib 窗口（双向约 300 KB）——受限于少数浏览器连接，有界。
