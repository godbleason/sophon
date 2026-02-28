/**
 * Web 工具集
 *
 * 提供网络相关能力：
 * - web_search: 通过搜索引擎搜索网页信息
 * - fetch_url: 获取指定 URL 的网页内容（自动提取正文）
 */

import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import { ToolExecutionError } from '../core/errors.js';

const DEFAULT_TIMEOUT = 30000; // 30s
const MAX_CONTENT_LENGTH = 15000; // 截断上限

// ─── Helper: HTTP fetch with timeout ───────────────────────

interface FetchOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

async function httpFetch(url: string, opts: FetchOptions = {}): Promise<{ status: number; body: string; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Sophon/1.0; +https://github.com/sophon)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...opts.headers,
      },
      redirect: 'follow',
    });
    const body = await res.text();
    return { status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helper: Extract text from HTML ────────────────────────

function extractTextFromHTML(html: string): string {
  // Remove script and style blocks
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Extract title
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim() : '';

  // Extract meta description
  const descMatch = text.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
    || text.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const description = descMatch ? descMatch[1]!.trim() : '';

  // Remove all tags, keep text
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (description) parts.push(`Description: ${description}`);
  parts.push('');
  parts.push(text);

  return parts.join('\n');
}

// ─── Helper: truncate ──────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.substring(0, max) + '\n\n... (content truncated)';
}

// ═══════════════════════════════════════════════════════════
// Tool 1: Web Search
// ═══════════════════════════════════════════════════════════

/**
 * Web 搜索工具
 *
 * 使用 DuckDuckGo HTML 搜索（无需 API Key），提取搜索结果。
 * 如果环境变量中配置了 SERPAPI_KEY 或 SERPER_API_KEY，
 * 则优先使用对应的搜索 API 获取更高质量的结果。
 */
export class WebSearchTool implements Tool {
  readonly name = 'web_search';
  readonly description =
    'Search the web for information. Returns a list of relevant results with titles, URLs, and snippets. ' +
    'Use this when you need up-to-date information or facts you are unsure about.';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5, max: 10)',
      },
    },
    required: ['query'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const query = params['query'] as string;
    const maxResults = Math.min((params['maxResults'] as number) || 5, 10);

    if (!query || query.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('Search query cannot be empty'));
    }

    // Try API-based search first, then fallback to DuckDuckGo HTML
    const serperKey = process.env['SERPER_API_KEY'];
    const serpApiKey = process.env['SERPAPI_KEY'];

    try {
      if (serperKey) {
        return await this.searchWithSerper(query, maxResults, serperKey);
      } else if (serpApiKey) {
        return await this.searchWithSerpApi(query, maxResults, serpApiKey);
      } else {
        return await this.searchWithDuckDuckGo(query, maxResults);
      }
    } catch (err) {
      throw new ToolExecutionError(this.name, params, err as Error);
    }
  }

  /** Serper.dev Google Search API */
  private async searchWithSerper(query: string, maxResults: number, apiKey: string): Promise<string> {
    const postRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: maxResults }),
    });

    if (!postRes.ok) {
      throw new Error(`Serper API error: ${postRes.status} ${postRes.statusText}`);
    }

    const data = await postRes.json() as {
      organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      answerBox?: { answer?: string; snippet?: string; title?: string };
      knowledgeGraph?: { title?: string; description?: string };
    };

    const lines: string[] = [`🔍 Search results for: "${query}"\n`];

    // Answer box
    if (data.answerBox) {
      const ab = data.answerBox;
      lines.push(`📋 Quick Answer: ${ab.answer || ab.snippet || ''}`);
      lines.push('');
    }

    // Knowledge graph
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      lines.push(`📖 ${kg.title || ''}: ${kg.description || ''}`);
      lines.push('');
    }

    // Organic results
    if (data.organic) {
      for (let i = 0; i < Math.min(data.organic.length, maxResults); i++) {
        const r = data.organic[i]!;
        lines.push(`${i + 1}. ${r.title || '(no title)'}`);
        lines.push(`   URL: ${r.link || ''}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push('');
      }
    }

    return lines.join('\n').trim() || 'No results found.';
  }

  /** SerpAPI Google Search */
  private async searchWithSerpApi(query: string, maxResults: number, apiKey: string): Promise<string> {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('num', String(maxResults));
    url.searchParams.set('engine', 'google');

    const { body, status } = await httpFetch(url.toString());

    if (status !== 200) {
      throw new Error(`SerpAPI error: ${status}`);
    }

    const data = JSON.parse(body) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
      answer_box?: { answer?: string; snippet?: string };
    };

    const lines: string[] = [`🔍 Search results for: "${query}"\n`];

    if (data.answer_box) {
      lines.push(`📋 Quick Answer: ${data.answer_box.answer || data.answer_box.snippet || ''}`);
      lines.push('');
    }

    if (data.organic_results) {
      for (let i = 0; i < Math.min(data.organic_results.length, maxResults); i++) {
        const r = data.organic_results[i]!;
        lines.push(`${i + 1}. ${r.title || '(no title)'}`);
        lines.push(`   URL: ${r.link || ''}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push('');
      }
    }

    return lines.join('\n').trim() || 'No results found.';
  }

  /** DuckDuckGo HTML search (no API key needed) */
  private async searchWithDuckDuckGo(query: string, maxResults: number): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { body, status } = await httpFetch(url);

    if (status !== 200) {
      throw new Error(`DuckDuckGo returned status ${status}`);
    }

    // Parse results from HTML
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // Match result blocks: <a class="result__a" href="...">title</a>
    // and <a class="result__snippet" ...>snippet</a>
    const resultBlocks = body.split(/class="result\s/);

    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i]!;

      // Extract URL
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      if (!urlMatch) continue;

      let resultUrl = urlMatch[1]!;
      // DuckDuckGo wraps URLs in redirect
      const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        resultUrl = decodeURIComponent(uddgMatch[1]!);
      }

      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch
        ? titleMatch[1]!.replace(/<[^>]+>/g, '').trim()
        : '(no title)';

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch
        ? snippetMatch[1]!.replace(/<[^>]+>/g, '').trim()
        : '';

      if (resultUrl && !resultUrl.startsWith('/')) {
        results.push({ title, url: resultUrl, snippet });
      }
    }

    if (results.length === 0) {
      return `🔍 Search results for: "${query}"\n\nNo results found. Try different keywords.`;
    }

    const lines: string[] = [`🔍 Search results for: "${query}"\n`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   URL: ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }
}

// ═══════════════════════════════════════════════════════════
// Tool 2: Fetch URL
// ═══════════════════════════════════════════════════════════

/**
 * URL 内容获取工具
 *
 * 抓取指定 URL 的网页内容，自动提取正文文本。
 * 支持 HTML 页面（自动去标签提取文本）和 JSON/纯文本。
 */
export class FetchUrlTool implements Tool {
  readonly name = 'fetch_url';
  readonly description =
    'Fetch the content of a web page by URL. Automatically extracts the main text content from HTML pages. ' +
    'Use this to read articles, documentation, or any web page content. ' +
    'For JSON APIs, returns the raw JSON response.';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      raw: {
        type: 'boolean',
        description: 'If true, return raw HTML/response without text extraction (default: false)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['url'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const url = params['url'] as string;
    const raw = params['raw'] as boolean ?? false;
    const timeout = (params['timeout'] as number) || DEFAULT_TIMEOUT;

    if (!url || url.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('URL cannot be empty'));
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      throw new ToolExecutionError(this.name, params, new Error(`Invalid URL: ${url}`));
    }

    try {
      const { status, body, headers } = await httpFetch(url, { timeout });

      if (status >= 400) {
        return `Error: HTTP ${status} when fetching ${url}`;
      }

      const contentType = headers.get('content-type') || '';

      // JSON response
      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(body);
          const formatted = JSON.stringify(parsed, null, 2);
          return truncate(`URL: ${url}\nContent-Type: ${contentType}\n\n${formatted}`, MAX_CONTENT_LENGTH);
        } catch {
          return truncate(`URL: ${url}\nContent-Type: ${contentType}\n\n${body}`, MAX_CONTENT_LENGTH);
        }
      }

      // Plain text
      if (contentType.includes('text/plain') || contentType.includes('text/csv') || contentType.includes('text/xml') || contentType.includes('application/xml')) {
        return truncate(`URL: ${url}\nContent-Type: ${contentType}\n\n${body}`, MAX_CONTENT_LENGTH);
      }

      // HTML - extract text unless raw requested
      if (raw) {
        return truncate(`URL: ${url}\nContent-Type: ${contentType}\n\n${body}`, MAX_CONTENT_LENGTH);
      }

      const extracted = extractTextFromHTML(body);
      return truncate(`URL: ${url}\n\n${extracted}`, MAX_CONTENT_LENGTH);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ToolExecutionError(this.name, params, new Error(`Request timed out after ${timeout}ms`));
      }
      throw new ToolExecutionError(this.name, params, err as Error);
    }
  }
}
