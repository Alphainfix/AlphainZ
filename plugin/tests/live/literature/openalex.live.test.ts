/**
 * Live OpenAlex checks. Network-dependent, so kept out of the unit suite:
 * run with `npx vitest run --config vitest.live.config.ts` or directly by path.
 */
import { describe, expect, it } from 'vitest';
import { OpenAlexClient, formatWorksForModel } from '../../../src/services/literature/openalex';

const client = new OpenAlexClient(globalThis.fetch as any);

describe('OpenAlex 实网校验', () => {
  it('搜索 honeybee waggle dance 并解析真实响应', async () => {
    const r = await client.search('honeybee waggle dance distance communication', { perPage: 3 });
    console.log('\n  总命中:', r.total, '| 返回:', r.works.length);
    for (const w of r.works) {
      console.log(`  - [${w.id}] ${w.title.slice(0, 60)}`);
      console.log(`      year=${w.year} doi=${w.doi ?? '-'} cited=${w.citedByCount} venue=${w.venue ?? '-'}`);
      console.log(`      authors=${w.authors.length} 摘要=${w.abstract ? w.abstract.length + '字符' : '无'} OA=${w.openAccessUrl ? 'y' : 'n'}`);
    }
    expect(r.total).toBeGreaterThan(0);
    expect(r.works.length).toBe(3);
    // 关键断言：这些字段必须真的解析出来了，不是全 undefined
    expect(r.works.every(w => w.id.startsWith('W'))).toBe(true);
    expect(r.works.every(w => w.title !== '(untitled)')).toBe(true);
    expect(r.works.some(w => w.year !== undefined)).toBe(true);
    expect(r.works.some(w => w.authors.length > 0)).toBe(true);
  }, 30000);

  it('摘要重建在真实数据上产出可读英文', async () => {
    const r = await client.search('honeybee navigation', { perPage: 5 });
    const withAbstract = r.works.filter(w => w.abstract);
    console.log('\n  有摘要:', withAbstract.length, '/', r.works.length);
    if (withAbstract[0]) console.log('  样例:', withAbstract[0].abstract!.slice(0, 180));
    expect(withAbstract.length).toBeGreaterThan(0);
    // 重建失败的典型症状是出现连续空格或空词
    expect(withAbstract[0].abstract).not.toMatch(/\s{3,}/);
  }, 30000);

  it('引用网络 cites: 过滤器真的能用', async () => {
    const r = await client.search('honeybee waggle dance', { perPage: 1 });
    const seed = r.works[0].id;
    const citing = await client.citedBy(seed, { perPage: 3 });
    console.log(`\n  ${seed} 被引:`, citing.total);
    expect(citing.total).toBeGreaterThan(0);
  }, 30000);

  it('DOI 反查', async () => {
    const w = await client.byDoi('10.1038/171737a0');
    console.log('\n  DOI 反查:', w?.title, '|', w?.year, '|', w?.id);
    expect(w).not.toBeNull();
    expect(w!.year).toBe(1953);
  }, 30000);

  it('给模型的格式化输出', async () => {
    const r = await client.search('sourdough fermentation temperature', { perPage: 2 });
    const out = formatWorksForModel(r.works, 150);
    console.log('\n' + out.split('\n').map(l => '  ' + l).join('\n'));
    expect(out).toContain('OpenAlex: W');
  }, 30000);
});
