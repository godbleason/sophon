/**
 * 技能加载器
 * 
 * 从技能目录加载 Markdown 格式的技能文件。
 * 支持 YAML frontmatter 元数据。
 * 
 * 技能文件格式:
 * ```markdown
 * ---
 * name: skill-name
 * description: 技能描述
 * dependencies:
 *   - cli: git
 *   - env: GITHUB_TOKEN
 * always_load: false
 * ---
 * 
 * # 技能标题
 * 
 * 技能内容...
 * ```
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('SkillsLoader');

/** 技能元数据 */
export interface SkillMeta {
  name: string;
  description: string;
  dependencies?: Array<{ cli?: string; env?: string }>;
  alwaysLoad?: boolean;
}

/** 加载后的技能 */
export interface Skill {
  meta: SkillMeta;
  content: string;
  filePath: string;
}

/**
 * 解析 YAML frontmatter（简易实现，无需 yaml 依赖）
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { meta: {}, body: content };
  }

  const yamlStr = match[1]!;
  const body = match[2]!;

  // 简易 YAML 解析（仅支持简单 key: value）
  const meta: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');
  let currentKey = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 检查是否是列表项
    if (trimmed.startsWith('- ') && currentKey) {
      const listItem = trimmed.substring(2).trim();
      if (!Array.isArray(meta[currentKey])) {
        meta[currentKey] = [];
      }

      // 解析 "key: value" 格式的列表项
      const colonIdx = listItem.indexOf(':');
      if (colonIdx !== -1) {
        const itemKey = listItem.substring(0, colonIdx).trim();
        const itemValue = listItem.substring(colonIdx + 1).trim();
        (meta[currentKey] as Array<Record<string, string>>).push({ [itemKey]: itemValue });
      } else {
        (meta[currentKey] as string[]).push(listItem);
      }
      continue;
    }

    // key: value
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();

      // 转换 snake_case 为 camelCase
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      currentKey = camelKey;

      if (value === '') {
        // 可能是列表或对象的开始
        meta[camelKey] = [];
      } else if (value === 'true') {
        meta[camelKey] = true;
      } else if (value === 'false') {
        meta[camelKey] = false;
      } else {
        meta[camelKey] = value;
      }
    }
  }

  return { meta, body };
}

/**
 * 检查技能依赖是否满足
 */
function checkDependencies(deps?: Array<{ cli?: string; env?: string }>): string[] {
  if (!deps) return [];

  const missing: string[] = [];

  for (const dep of deps) {
    if (dep.cli) {
      // 检查 CLI 工具是否存在 —— 简单检查 PATH
      // 注意：这里只做记录，不阻止加载
      log.debug({ cli: dep.cli }, '依赖检查: CLI 工具');
    }

    if (dep.env && !process.env[dep.env]) {
      missing.push(`环境变量 ${dep.env} 未设置`);
    }
  }

  return missing;
}

/**
 * 技能加载器
 */
export class SkillsLoader {
  private readonly skillsDir: string;
  private skills: Skill[] = [];

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /**
   * 加载所有技能
   */
  async loadAll(): Promise<Skill[]> {
    if (!existsSync(this.skillsDir)) {
      log.info({ dir: this.skillsDir }, '技能目录不存在，跳过加载');
      return [];
    }

    const files = await readdir(this.skillsDir);
    const mdFiles = files.filter((f) => extname(f) === '.md');

    this.skills = [];

    for (const file of mdFiles) {
      try {
        const skill = await this.loadSkill(join(this.skillsDir, file));
        this.skills.push(skill);
        log.info({ name: skill.meta.name, file }, '技能已加载');
      } catch (err) {
        log.error({ err, file }, '技能加载失败');
        throw err;
      }
    }

    log.info({ count: this.skills.length }, '技能加载完成');
    return this.skills;
  }

  /**
   * 加载单个技能文件
   */
  private async loadSkill(filePath: string): Promise<Skill> {
    const content = await readFile(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);

    const skillMeta: SkillMeta = {
      name: (meta['name'] as string) || filePath.split('/').pop()?.replace('.md', '') || 'unknown',
      description: (meta['description'] as string) || '',
      dependencies: meta['dependencies'] as Array<{ cli?: string; env?: string }>,
      alwaysLoad: meta['alwaysLoad'] as boolean | undefined,
    };

    // 检查依赖
    const missing = checkDependencies(skillMeta.dependencies);
    if (missing.length > 0) {
      log.warn({ name: skillMeta.name, missing }, '技能依赖缺失');
    }

    return {
      meta: skillMeta,
      content: body.trim(),
      filePath,
    };
  }

  /**
   * 获取应始终加载的技能
   */
  getAlwaysLoadSkills(): Skill[] {
    return this.skills.filter((s) => s.meta.alwaysLoad);
  }

  /**
   * 获取所有已加载的技能
   */
  getAllSkills(): Skill[] {
    return [...this.skills];
  }

  /**
   * 按名称获取技能
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.find((s) => s.meta.name === name);
  }

  /**
   * 获取用于系统提示的技能内容
   */
  getSkillsForPrompt(): string {
    const alwaysLoad = this.getAlwaysLoadSkills();
    if (alwaysLoad.length === 0) return '';

    const sections = alwaysLoad.map((s) =>
      `<skill name="${s.meta.name}">\n${s.content}\n</skill>`
    );

    return `\n\n<skills>\n${sections.join('\n\n')}\n</skills>`;
  }
}
