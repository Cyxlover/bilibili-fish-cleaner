## Where things are

- `README.md` — 这个扩展是什么、怎么安装、怎么用。
- `INSTALL.md` — 面向使用者的安装与卸载说明。
- `engine/README.md` — 判定引擎的契约：线索、门槛、规则版本与 API。
- `GLOSSARY.md` — 本项目术语。
- `CODING_STANDARDS.md` — 需要判断的编码规则（测试用真实模块、写完必须接线等）。
- `docs/agents/delegating-implementation.md` — 把活交给 subagent/teammate 时的护栏与报告格式；派工前作为提示词的一部分。

规格与工单不随仓库发布：需求规格、研究数据、审查报告与实现工单都留在维护者本地（`.scratch/<feature>/`）。如果你是在本地开发，那里才是需求的唯一真相来源，工单与规格冲突时以规格为准。

## 改完先自检

`npm run check` 一次跑完语法、引擎产物新鲜度、manifest 完整性、单元测试与规则回归。改了 `engine/` 必须先 `npm run build:engine` 再提交，否则线上跑的是旧规则。`npm run hooks:install` 装一次 git 钩子后，提交与推送会自动拦住这两类问题。

## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
