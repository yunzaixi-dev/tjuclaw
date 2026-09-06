import { useEffect, useRef, useState } from 'react';
import { viewports, type AuthManifest, type Screen } from './audit-types';

const evidenceLabels = {
  render: '路由实拍',
  'real-kratos': '真实 Kratos',
  'injected-response': '注入异常测试',
};

export function AuthAudit({ screens, refresh, onReference, onZoom }: {
  screens: Screen[]; refresh: number;
  onReference: (screen: Screen) => void;
  onZoom: (image: { src: string; title: string }) => void;
}) {
  const [data, setData] = useState<AuthManifest>();
  const [error, setError] = useState('');
  const [id, setId] = useState('login');
  const [viewport, setViewport] = useState<string>('phone');
  const [theme, setTheme] = useState('light');
  const [overlay, setOverlay] = useState(false);
  const [opacity, setOpacity] = useState(50);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/__audit/auth', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('尚未生成登录证据，请运行 task audit:auth 后刷新。');
      return response.json();
    }).then(value => { setData(value); setError(''); }).catch(e => {
      if (e.name !== 'AbortError') setError(e.message);
    });
    return () => controller.abort();
  }, [refresh]);
  if (error) return <section className="empty-state" role="alert"><h2>登录证据未就绪</h2><p>{error}</p></section>;
  if (!data) return <section className="empty-state" role="status">正在读取登录实拍…</section>;
  const state = data.states.find(item => item.id === id) || data.states[0];
  const reference = screens.find(item => item.id === state.referenceId);
  const vp = viewports.find(item => item.id === viewport)!;
  const key = `${viewport}-${theme}`;
  const capture = state.captures[key];
  const count = data.states.filter(item => item.captures[key]).length;
  const picture = (src: string, title: string) => <button className="picture"
    onClick={() => onZoom({ src, title })} aria-label={`放大：${title}`}><img src={src} alt={title} /></button>;
  function choose(next: string, reveal = false) {
    setId(next); setOverlay(false);
    if (reveal) heading.current?.scrollIntoView({ block: 'start' });
  }
  return <section className="content auth-review">
    <header className="screen-heading">
      <div><code>Web / Email OTP</code><h2>{data.name}</h2><p>{data.scope}</p></div>
      <div className="auth-run"><strong>{count} / {data.states.length} 个状态有图</strong>
        <span>本次 {data.run.passed} 项测试通过</span>
        <time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleString('zh-CN')}</time>
        <small>历史测试记录，不代表当前代码仍通过</small></div>
    </header>
    <details className="auth-boundaries"><summary>验收边界与待办 · {data.gaps.length} 项</summary>
      <ul>{data.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></details>
    <div className="auth-controls">
      <label>页面状态<select value={state.id} onChange={e => choose(e.target.value)}>
        {data.states.map(item => <option key={item.id} value={item.id}>{item.title}{item.captures[key] ? '' : ' · 缺图'}</option>)}
      </select></label>
      <div className="auth-theme" role="group" aria-label="实现截图主题">
        {['light', 'dark'].map(value => <button key={value} aria-pressed={theme === value}
          onClick={() => setTheme(value)}>{value === 'light' ? '浅色' : '深色'}</button>)}
      </div>
    </div>
    <div className="compare-toolbar"><div className="viewport-tabs">{viewports.map(item => <button
      key={item.id} aria-pressed={viewport === item.id} onClick={() => setViewport(item.id)}>
      {item.label}<small>{item.width} × {item.height}</small><span>{state.captures[`${item.id}-${theme}`] ? '已实拍' : '缺图'}</span>
    </button>)}</div><button className="outlined" disabled={!reference || !capture}
      aria-pressed={overlay} onClick={() => setOverlay(!overlay)}>{overlay ? '回到并排' : '叠加检查'}</button></div>
    <div ref={heading} className="auth-state-heading"><h3>{state.title}</h3><span className={`evidence-label ${state.evidence}`}>{evidenceLabels[state.evidence]}</span><code>{state.route}</code></div>
    <p className="auth-comparison">{state.comparison}</p>
    {overlay && reference && capture ? <div className="overlay">
      <header><label>实现图透明度 <input aria-label="登录实现图透明度" type="range" min="0" max="100" value={opacity} onChange={e => setOpacity(Number(e.target.value))} />{opacity}%</label><span>完整图片等高适配，仅供视觉检查，非像素评分</span></header>
      <div><img src={reference.reference} alt="登录参考底图" /><img style={{ opacity: opacity / 100 }} src={capture.url} alt="登录实现叠加图" /></div>
    </div> : <div className="compare-grid">
      <section className="evidence"><header><div><span>参考</span><strong>{reference?.id || '无直接对应'}</strong></div>
        {reference && <code>{reference.width} × {reference.height}</code>}</header>
        <div className="stage reference">{reference ? picture(reference.reference, `${reference.id} · 登录视觉参考`)
          : <div className="capture-empty"><h3>这是产品新增状态。</h3><p>没有可确认的同状态参考图，<br />不挪用其他认证页面凑对照。</p></div>}</div>
        <footer><span>参考映射不代表交互相同</span>{reference && <button className="text-button" onClick={() => onReference(reference)}>查看逐图描述 ↗</button>}</footer>
      </section>
      <section className="evidence"><header><div><span className="implementation">实现</span><strong>{theme === 'light' ? '浅色' : '深色'} · {vp.label}</strong></div><code>{vp.width} × {vp.height}</code></header>
        <div className="stage">{capture ? picture(capture.url, `${state.title} · ${vp.label} · ${theme}`)
          : <div className="capture-empty"><h3>此尺寸或主题缺少实拍</h3><p>运行 task audit:auth 补充，缺图不会算作通过。</p></div>}</div>
        <footer><span>{capture ? `实拍 ${new Date(capture.updatedAt).toLocaleString('zh-CN')}` : '尚无证据'}</span><span>OTP 已遮挡</span></footer>
      </section>
    </div>}
    <section className="auth-matrix"><h3>尺寸与主题覆盖</h3><p>选择任一格查看对应实拍；有图不等于视觉验收通过。</p>
      <div className="auth-table-scroll"><table><thead><tr><th scope="col">状态</th>{viewports.map(item => <th key={item.id} scope="col">{item.label}<small>{item.width} × {item.height}</small></th>)}</tr></thead>
        <tbody>{data.states.map(item => <tr key={item.id} aria-selected={item.id === state.id}><th scope="row"><button onClick={() => choose(item.id, true)}>{item.title}</button></th>
          {viewports.map(size => <td key={size.id}>{['light', 'dark'].map(color => <button key={color}
            aria-label={`${item.title} ${size.label} ${color === 'light' ? '浅色' : '深色'}${item.captures[`${size.id}-${color}`] ? '' : ' 缺图'}`}
            onClick={() => { choose(item.id, true); setViewport(size.id); setTheme(color); }}
            className={item.captures[`${size.id}-${color}`] ? 'captured' : ''}>{color === 'light' ? '浅' : '深'}{item.captures[`${size.id}-${color}`] ? ' · 有图' : ' · 缺图'}</button>)}</td>)}
        </tr>)}</tbody></table></div>
    </section>
    <section className="flow auth-flows"><h2>邮箱登录交互线路</h2><p className="flow-note">节点切换上方对照。以下是当前产品路径，不沿用参考图推断线路；测试范围以每组说明为准。</p>
      {data.journeys.map(journey => <section className="journey" key={journey.title}><header><div><h3>{journey.title}</h3><p>{journey.note}</p></div></header>
        <ol className="auth-flow-nodes">{journey.nodes.map(node => {
          const item = data.states.find(candidate => candidate.id === node)!;
          return <li key={node}><button aria-pressed={item.id === state.id} onClick={() => choose(node, true)}>
            <strong>{item.title}</strong><small>{evidenceLabels[item.evidence]}</small></button></li>;
        })}</ol></section>)}
    </section>
  </section>;
}
