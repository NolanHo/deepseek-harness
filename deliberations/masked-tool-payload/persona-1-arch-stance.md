# persona-1-arch-stance.md

## 初始立场：有条件支持（对"mask 成摘要 + 专门 API"这一具体协议方案持反对）

按需传输方向正确，但协议层必须一次做对：wire 应保持权威、无损、可寻址的完整 transcript，拒绝为省字节引入带外 mask/摘要路径。

## 三个关键理由 / 最大风险

1. **破坏单一事实源**：摘要与原始事件并存会产生一致性、寻址与审计漂移；mask 不可逆，等于在协议里埋下两条事实链，后续所有一致性保证都要为此买单。
2. **带外专门 API 破坏现有寻址/打包语义**：现状是 pageEntries 分页 + chunk-row 对称无损解码；新增独立"展开端点"会分裂客户端路径、增加版本耦合与乱序/缺页边界情况。
3. **前提被证据证伪、且易漏大头**：首屏传输并非"仅 user/assistant 文本"（assistant 内含 reasoning/tool-call/sourceEventSeqs≈17.6%）；仅 mask tool/result 会漏掉 tool/code-dispatch.content 等真正大块。

## 可接受的替代

在既有事件寻址（seq/cursor 范围）之上做**无损、对称可展开**的按需拉取，先修 sourceEventSeqs 与 reasoning/tool-call 多重表示，而不是新增 mask/摘要。

## 立场摘要（给 lead）

有条件支持：按需可取，但拒绝 mask 摘要与带外专门 API，须无损可寻址并保持单一事实源。
