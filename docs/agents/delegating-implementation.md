# 派工护栏

把写代码的活交给 subagent / teammate 时，把这份文档的内容作为提示词的一部分。
每一条都对应本项目的一次真实事故；省掉任何一条，历史上都重做过一遍。

## 一、开工前三件事

1. **读规格，不只读工单。** 先读 `.scratch/comment-cleanup/spec.md` 里工单 `**Spec:**` 行指出的区间。
   工单与规格冲突时按规格做，并在工单 `## Comments` 记下冲突。
2. **认领 worktree，防止并发写入。**
   ```bash
   node scripts/worktree-claim.mjs ticket-03        # 已被占用则退出码 1
   ```
   同一时刻一个 worktree 只能有一个写者；完工或交接时加 `--release`。
3. **确认分支起点。** 新分支必须基于 `integration/comment-cleanup`；已在别的分支上就先 rebase/reset 过去。
   只改自己 worktree 里的文件，**绝不**自己往集成分支合并。

## 二、写代码的硬约束

- **零运行时依赖**：不许改 `dependencies`；需要浏览器自动化就用 `scripts/e2e/lib.mjs`（按绝对路径加载 `playwright-core`）。
- **测试驱动真实模块**：替身只许替换外部世界（网络、计时器、浏览器 API）。见 `CODING_STANDARDS.md` 第 1 条。
- **写完必须接线**：新文件要同时做到「被 manifest 或页面 HTML 加载」和「生产调用链上有人调用」。
- **不留死代码**：被取代的实现直接删，连它的测试一起删。
- **注释里的路径必须真实存在。**
- **不许编造数字**：报告里的测试数、条数、耗时都要来自实际运行的输出。

## 三、节奏：先提交，后完善

- **每完成一块立刻 commit**，不要攒到最后。历史上代理在「想清楚了再提交」阶段被掐断，整块工作全丢。
- commit message 说明这一块做了什么，不写「wip」「update」。
- **禁止过程自述**：不要输出「现在我要写 xxx」「接下来验证」，只做，不播报。
- **同一个报错最多排查 2 次**。第 3 次必须停下，把命令、完整报错、已排除的假设写进最终报告。
- 改了 `engine/` 必须 `npm run build:engine`，再 `npm run check`。

## 四、开浏览器的卫生要求

- 用固定已登录 profile `E:\大肥鱼清除计划\.e2e-profile`，**不要新建 profile**（未登录时评论区被限流，只会渲染极少数评论）。
- 滚动一律 `page.mouse.wheel()`；`window.scrollBy()` 会撞上站内跳转而抛
  `Execution context was destroyed, most likely because of a navigation`。
- 每个页面用完立刻 `close()`；结束一定关 context；最后杀残留 msedge（按命令行匹配 `*大肥鱼*`，按 profile 名匹配不到，路径含中文）。
- 设看门狗（建议 150s），超时退出并打印已完成到哪一步。
- 证据写入 `.scratch/comment-cleanup/validation/e2e-real/` 时**新开文件名**，绝不覆盖既有报告。

## 五、收工报告格式

最后一条消息只写这些，不要复述过程：

```
- 功能 commit: <hash>（+ 合并 commit <hash>）
- 改动文件: <路径列表>
- 验证: npm test <N pass / 0 fail>；node scripts/check.mjs <结果>
- 未完成 / 已知问题: <列表，没有就写「无」>
- worktree 已释放: 是/否
```

## 六、能力与角色

- subagent 是一次性的、结束后不可寻址；需要中途追加指令或多次唤醒，用 teammate。
- 团队名额上限 8 人（不含 lead）；实现工作优先用 subagent，名额留给需要串行协调的角色（合并、验收）。
- 按任务难度选思考强度：规则互斥、契约设计类给高；独立小切片、已有明确降级方案的给低。
- 同一 worktree 同时只派一个 owner；要并行就先开两个 worktree 并各自认领。
