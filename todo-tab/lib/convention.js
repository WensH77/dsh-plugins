// dsh-plugin-todo-tab — 待办约定域（常驻注入 + 技能）。
//
// 这套约定原先写在 ~/.dsh/AGENTS.md 里、细则放在 ~/.dsh/memory/TEMPLATE.md；
// 现在改由本插件携带，随 `dsh plugin add` 分发：
//   - 常驻：每个 agent 的 prompt scope 上挂一段很短的「触发器 + 铁律」（conventionText）；
//   - 按需：完整规范与骨架放在 skill/todo-memory/SKILL.md，注册成运行时技能，模型需要时加载。
// 常驻只放「每轮都必须生效」的部分，长文留给技能，避免白白占常驻预算。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 技能名（kebab-case，模型按这个名字加载）。 */
const SKILL_NAME = 'todo-memory';
/** 常驻 context 的名字（同一 scope 内唯一，重复注册会抛）。 */
const CONTEXT_NAME = 'todo-tab:todo-memory';
/**
 * 常驻 context 的 order。现有段位：PLAN_POLICY 500 / TEAM_POLICY 600，
 * 各 TOOL_* 从 1000 起，这里取 700，落在策略之后、工具说明之前。
 */
const CONTEXT_ORDER = 700;
/** 技能与骨架文件相对插件根的位置。 */
const SKILL_PATH = '../skill/todo-memory/SKILL.md';
const TEMPLATE_PATH = '../template/TODO.md';

/**
 * 常驻注入的正文：只写「什么时候必须做」和硬约束，细则指向技能。
 * @returns 注入文本。
 */
function conventionText() {
  return [
    '## 待办（TODO.md）',
    '',
    '每个工作区一份 `<DSH_HOME>/memory/<工作区>/TODO.md`，工作区名取会话工作目录的最后一段。',
    '',
    '出现「不记就会忘」的事、或清单里某条看起来已办结时，**先用 `ask_user_question` 问用户**要不要记 / 要不要删，得到肯定答复再动文件。',
    '',
    '一轮最多问一次；答过「不记」「先留着」或跳过不答的同一件事不再问、也不擅自写删，等有新证据再提。用户跳过某一问或没答都按「不记、不删」处理，下一次向用户开口时讲清「这条还没记 / 还没删」。',
    '',
    '用户已在对话里明说要记、要删的不必再问；说过「别问了」「你自己看着办」之后本会话不再提问，记录与删除都按下面的铁律自己办（这种授权即视为已经点头，但已经被明确拒过的条目不在此列）。提问走不通时不要硬问：没有 `ask_user_question` 工具或被宿主拒绝（子代理被上层代理托管时常见）时，已获授权自办的照授权办，没获授权的把候选与待删条目交给上层代理，自己就是根代理时写进回复正文。',
    '',
    '维护待办时遵守：',
    '',
    '- 只记**未完成**待办：办结的条目经用户确认后删除整条，不留 `[x]`、不写「已完成」小结（用户明确要求留痕才留）。',
    '- 「直接可做」的确定性小改动当场做掉，不写进清单——清单只承载「不记就会忘」的事。',
    '- 每条编号 `<工作区>-<序号>`（如 `dsh-plugins-3`），递增且**永不复用**；三类分组 A. 待裁决（需用户点头） / B. 需真实会话/重启验证 / C. 小债与清理，没内容的小节不写。',
    '- 写文件**只用插入式 `edit` 改单条（新增走插入、办结删整条），禁止用 `write` 整份覆盖**（同一工作区多个会话共用一份文件）。',
    '- 完整规范（字段要求、骨架、示例）见 `' + SKILL_NAME + '` 技能：动手前先加载它。'
  ].join('\n');
}

/**
 * 解析技能文件的 YAML frontmatter（只支持本插件自己写的简单 `key: value` 形态）。
 * @param source - SKILL.md 全文。
 * @returns `{ frontmatter, body }`；没有 frontmatter 时 frontmatter 为空对象。
 */
function parseSkillFile(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (entry === null) continue;
    let value = entry[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[entry[1]] = value;
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

/** 插件自带的技能文件与骨架文件的绝对路径。 */
function skillFilePath() {
  return fileURLToPath(new URL(SKILL_PATH, import.meta.url));
}
function templateFilePath() {
  return fileURLToPath(new URL(TEMPLATE_PATH, import.meta.url));
}

/**
 * 读出技能注册所需的定义：文件名/路由描述来自 frontmatter，正文末尾附上骨架文件路径，
 * 让模型需要时能直接取用。
 * @returns `{ name, description, whenToUse, content, path }`。
 */
async function loadSkill() {
  const path = skillFilePath();
  const parsed = parseSkillFile(await readFile(path, 'utf8'));
  const name = typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name !== '' ? parsed.frontmatter.name : SKILL_NAME;
  const description = parsed.frontmatter.description ?? '';
  const whenToUse = parsed.frontmatter.whenToUse;
  const body = parsed.body.trimEnd() + '\n\n> 骨架文件：`' + templateFilePath() + '`\n';
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    content: body,
    path
  };
}

export {
  CONTEXT_NAME,
  CONTEXT_ORDER,
  SKILL_NAME,
  conventionText,
  loadSkill,
  parseSkillFile,
  skillFilePath,
  templateFilePath
};
