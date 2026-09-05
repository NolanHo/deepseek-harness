# log.md — masked-tool-payload roundtable（volatile）

运行环境：本会话子代理无模型覆盖能力；workflow 子代理无文件工具（14 席全 null），改用 Team teammate（有工具），全部继承主模型 deepseek-v4-pro。persona 级多样性。

时间线：

1. evidence — researcher（probe-teammate）产出 research.md：payload 字节构成实测（工具 I/O 27.2%、可见文本 2.3%、sourceEventSeqs 17.6%、reasoning 双份）、代码现状（无 mask、无 range 寻址）、行业惯例 [unverified]。
2. stances — 三席预注册：arch 有条件支持（拒绝 mask 摘要 + 带外 API）；product 有条件支持（UX 门槛）；integrity 有条件支持（不变量 + 降级）。
3. discussion — product/integrity 向 arch 合流：反对不可逆 mask 摘要 + 带外专门 API，改为无损可寻址按需投影。
4. proposals — P1 可寻址按需投影；P2 可读折叠投影；P3 无损范围投影 + 确定性折叠索引。高度收敛。
5. arbitration — researcher 仲裁：-40% 须同时治理工具 I/O + sourceEventSeqs；「复用现有 range 参数」与代码不符；全部延迟目标无基线。
6. votes — 六票全「有条件支持」，无反对票；合并建议一致：保留单一事实源/无损投影/确定性计数+哈希/seq 窗口对称解码/降级回退/搜索缓存同源；放弃无证据硬承诺；sourceEventSeqs 治理独立前置。

结局：DeliberationRecord.md 待用户裁定。
