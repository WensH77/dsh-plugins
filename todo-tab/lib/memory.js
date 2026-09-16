// dsh-plugin-todo-tab — 工作区 TODO.md 定位域。
//
// 约定（见 ~/.dsh/AGENTS.md 与 ~/.dsh/memory/TEMPLATE.md）：每个工作区一份
// <DSH_HOME>/memory/<工作区>/TODO.md，工作区名取会话 cwd 的最后一段。
// 本模块只负责「cwd → 路径」与「读文件」：纯函数 + 一次读盘，不碰 ctx，便于单测。
import { basename, normalize } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

/** 待办文件名（约定固定值）。 */
const TASK_FILE = 'TODO.md';

/**
 * 会话 cwd → 工作区名（路径最后一段）。
 * @param cwd - 会话创建元数据里的绝对工作目录。
 * @returns 工作区名；无 cwd、空串或取不出名字（`.` / `..` / 根）时返回 null。
 */
function workspaceNameOf(cwd) {
  if (typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (trimmed === '') return null;
  const name = basename(normalize(trimmed));
  if (name === '' || name === '.' || name === '..') return null;
  return name;
}

/**
 * 工作区名 → TODO.md 的绝对路径。
 * @param workspace - {@link workspaceNameOf} 得到的工作区名。
 * @returns `<DSH_HOME>/memory/<工作区>/TODO.md`。
 */
function todoPathOf(workspace) {
  return dshHomePath('memory', workspace, TASK_FILE);
}

/**
 * 读取一个工作区的 TODO.md。
 * @param workspace - {@link workspaceNameOf} 得到的工作区名。
 * @returns 文件不存在时为 `{ exists: false, path }`；读到时为
 *   `{ exists: true, path, content, bytes, mtimeMs }`。其它读盘错误照常抛出。
 */
async function readTodo(workspace) {
  const path = todoPathOf(workspace);
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { exists: true, path, content, bytes: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { exists: false, path };
    throw error;
  }
}

export { TASK_FILE, readTodo, todoPathOf, workspaceNameOf };
