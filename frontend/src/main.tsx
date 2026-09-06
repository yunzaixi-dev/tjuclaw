import { StrictMode, useDeferredValue, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { version } from '../../package.json';
import { viewports, type Manifest, type Screen } from './audit-types';
import './styles.css';

function Description({ id }: { id: string }) {
  const [text, setText] = useState('正在读取逐图描述…');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/__audit/description/${id}`, { signal: controller.signal }).then(r => {
      if (!r.ok) throw new Error('描述不可用，请重新生成索引。'); return r.text();
    }).then(setText).catch(e => { if (e.name !== 'AbortError') setText(e.message); });
    return () => controller.abort();
  }, [id]);
  return <section className="description"><header><h2>逐图观察</h2><a href={`/__audit/description/${id}`} download={`${id}.md`}>下载 Markdown ↗</a></header>
    <div className="markdown">{text.split('\n').map((line, i) => /^#+ /.test(line)
      ? <h3 key={i}>{line.replace(/^#+ /, '')}</h3> : line.trim() ? <p key={i}>{line.replace(/\*\*/g, '')}</p> : null)}</div></section>;
}

function Audit() {
  const [data, setData] = useState<Manifest>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [id, setId] = useState(location.hash.slice(1));
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query);
  const [category, setCategory] = useState('');
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState('compare');
  const [viewport, setViewport] = useState<string>('phone');
  const [overlay, setOverlay] = useState(false);
  const [opacity, setOpacity] = useState(50);
  const [zoom, setZoom] = useState<{ src: string; title: string }>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/__audit/manifest', { signal: controller.signal }).then(r => {
      if (!r.ok) throw new Error('本地索引未就绪，请运行 task audit:index 后刷新。'); return r.json();
    }).then(value => { if (!value.screens?.length) throw new Error('索引没有截图。'); setData(value); setError(''); })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const update = () => setId(location.hash.slice(1));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => { if (zoom) dialog.current?.showModal(); else dialog.current?.close(); }, [zoom]);
  const screens = data?.screens || [];
  const current = screens.find(s => s.id === id) || screens[0];
  const filtered = screens.filter(s => (!category || s.category === category) && (!missing || !s.captures[viewport])
    && `${s.id} ${s.title} ${s.summary}`.toLowerCase().includes(search.toLowerCase()));
  const vp = viewports.find(v => v.id === viewport)!;
  const capture = current?.captures[viewport];
  function choose(s: Screen) { setId(s.id); window.history.pushState(null, '', `#${s.id}`); setOverlay(false); setNotice(''); }
  async function upload(file: File) {
    const target = current.id;
    const targetViewport = viewport;
    setBusy(true); setNotice('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('PNG 最大 20 MB。');
      const bitmap = await createImageBitmap(file);
      const correct = bitmap.width === vp.width && bitmap.height === vp.height;
      bitmap.close();
      if (!correct) throw new Error(`需要 ${vp.width} × ${vp.height} 像素，不会自动拉伸图片。`);
      const response = await fetch(`/__audit/runtime/${target}/${targetViewport}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: file });
      if (!response.ok) throw new Error(await response.text());
      setNotice(`${target} · ${vp.label}截图已保存到本地。`); setRefresh(v => v + 1);
    } catch (e) { setNotice(e instanceof Error ? e.message : '导入失败'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  function picture(src: string, title: string) {
    return <button className="picture" onClick={() => setZoom({ src, title })} aria-label={`放大：${title}`}>
      <img src={src} alt={title} /></button>;
  }
  return <div className="audit">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">T</span><strong>TJUClaw<small>Visual review desk</small></strong></div>
      <div className="collection"><i />本地研究集 <span>{screens.length}</span></div>
      <label className="search"><span aria-hidden="true">⌕</span><input aria-label="搜索截图" placeholder="搜索页面、状态或编号" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select aria-label="页面分类" value={category} onChange={e => setCategory(e.target.value)}><option value="">全部页面分类</option>{[...new Set(screens.map(s => s.category))].map(c => <option key={c}>{c}</option>)}</select>
      <label className="missing-filter"><input type="checkbox" checked={missing} onChange={e => setMissing(e.target.checked)} />仅看当前尺寸缺图</label>
      <nav className="screen-index" aria-label="截图索引">{filtered.map(s => <button key={s.id} className={current?.id === s.id ? 'selected' : ''} aria-current={current?.id === s.id ? 'page' : undefined} onClick={() => { choose(s); setMode('compare'); }}>
        <code>{String(s.index).padStart(3, '0')}</code><span><strong>{s.title}</strong><small>{s.category}</small></span><i className={s.captures[viewport] ? 'ready' : ''} /></button>)}
        {data && !filtered.length && <p className="empty-filter">没有匹配结果，请调整筛选。</p>}</nav>
      <footer>证据不进入产品构建 <code>v{version}</code></footer>
    </aside>
    <main className="desk">
      <header className="topbar"><div><span>设计审计</span><b>/</b><strong>{data?.name || '本地视觉证据'}</strong></div><button className="text-button" onClick={() => setRefresh(v => v + 1)}>刷新证据 ↻</button></header>
      <section className="intro"><div><p>看清差异，再推进实现。</p><h1>每一个状态，都有据可对。</h1></div><div className="coverage"><code>{screens.filter(s => s.captures[viewport]).length} / {screens.length}</code><p>{vp.label}已关联截图 · 不等于验收通过</p></div></section>
      <div className="tabs">{[['compare', '截图对照'], ['flow', '交互线路'], ['gallery', '全部参考']].map(([key, label]) => <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}<span>{filtered.length} 个匹配页面</span></div>
      {error ? <section className="empty-state" role="alert"><h2>还没有读到证据</h2><p>{error}</p></section> : !current ? <section className="empty-state" role="status">正在加载证据…</section> : <>
        {mode === 'compare' && <div className="content">
          <section className="screen-heading"><div><code>{current.id} <span>/ {current.category}</span></code><h2>{current.title}</h2><p>{current.summary}</p></div><div className="paging"><button aria-label="上一张" disabled={current.index === 0} onClick={() => choose(screens[current.index - 1])}>←</button><code>{current.index + 1}/{screens.length}</code><button aria-label="下一张" disabled={current.index === screens.length - 1} onClick={() => choose(screens[current.index + 1])}>→</button></div></section>
          <div className="compare-toolbar"><div className="viewport-tabs">{viewports.map(v => <button key={v.id} aria-pressed={viewport === v.id} onClick={() => { setViewport(v.id); setOverlay(false); setNotice(''); }}>{v.label}<small>{v.width} × {v.height}</small><span>{current.captures[v.id] ? '已关联' : '缺图'}</span></button>)}</div><button className="outlined" disabled={!capture} aria-pressed={overlay} onClick={() => setOverlay(!overlay)}>{overlay ? '回到并排' : '叠加检查'}</button></div>
          {overlay && capture ? <div className="overlay">
            <header><label>实现图透明度 <input aria-label="实现图透明度" type="range" min="0" max="100" value={opacity} onChange={e => setOpacity(Number(e.target.value))} />{opacity}%</label><span>完整图片等高适配，非像素级差异评分</span></header>
            <div><img src={current.reference} alt="参考底图" /><img style={{ opacity: opacity / 100 }} src={capture.url} alt="实现叠加图" /></div>
          </div> : <div className="compare-grid">
            <section className="evidence"><header><div><span>参考</span><strong>原始截图</strong></div><code>{current.width} × {current.height}</code></header><div className="stage reference">{picture(current.reference, `${current.id} · 参考原图`)}</div><footer><span>保留原比例与原始水印</span><button className="text-button" onClick={() => setZoom({ src: current.reference, title: current.title })}>查看原图 ↗</button></footer></section>
            <section className="evidence"><header><div><span className="implementation">实现</span><strong>TJUClaw · {vp.label}</strong></div><code>{vp.width} × {vp.height}</code></header><div className="stage">{capture ? picture(capture.url, `${current.id} · ${vp.label}实现`) : <div className="capture-empty"><span aria-hidden="true">＋</span><h3>这个尺寸，还缺一张实拍。</h3><p>关联相同页面状态的实现截图，<br />让对照基于实际界面，而不是推测。</p><button className="primary" disabled={busy} onClick={() => input.current?.click()}>导入{vp.label} PNG</button><code>{vp.width} × {vp.height} px · 最大 20 MB</code></div>}</div><footer><span>{capture ? `本地导入 · ${new Date(capture.updatedAt).toLocaleDateString('zh-CN')}` : '尚未关联 · 不生成假截图'}</span><button className="text-button" disabled={busy} onClick={() => input.current?.click()}>{capture ? '替换截图' : '选择文件'} ↗</button></footer></section>
          </div>}
          <input className="sr-only" ref={input} type="file" accept="image/png" aria-label="导入实现截图" disabled={busy} onChange={e => { if (e.target.files?.[0]) void upload(e.target.files[0]); }} />
          <p className="notice" role="status">{busy ? '正在校验并保存…' : notice}</p>
          <section className="connections"><h3>从这个状态出发</h3>{current.transitions.length ? current.transitions.map((edge, i) => <button key={i} onClick={() => choose(screens.find(s => s.id === edge.to)!)}><span>{edge.action}</span><strong>→ {edge.to}</strong><small>推断 · 待验证</small></button>) : <p>现有截图不足以确认下一步，不虚构跳转。</p>}</section>
          <Description key={current.id} id={current.id} />
        </div>}
        {mode === 'flow' && <section className="content flow"><h2>交互线路图</h2><p className="flow-note">按任务组织页面。虚线箭头为有依据的推断；“同组”仅表示状态归类，不确认跳转。点击节点进入对照。</p>
          {data!.journeys.map((journey, index) => <section className="journey" key={journey.title}><header><code>{String(index + 1).padStart(2, '0')}</code><div><h3>{journey.title}</h3><p>{journey.note}</p></div><small>{journey.nodes.length} 个状态</small></header>
            <div className="journey-scroll"><div className="journey-nodes">{journey.nodes.map((node, i) => {
              const s = screens.find(s => s.id === node)!;
              const edge = screens.find(s => s.id === journey.nodes[i - 1])?.transitions.find(e => e.to === node);
              return <div className="flow-step" key={node}>{i > 0 && <div className="connector">{edge ? <><span>{edge.action}</span><svg viewBox="0 0 70 20" aria-hidden="true"><path d="M0 10H66M60 5L66 10L60 15" /></svg></> : <span>同组</span>}</div>}<button className="flow-node" onClick={() => { choose(s); setMode('compare'); }}><img src={s.reference} alt="" loading="lazy" /><code>{s.id}</code><strong>{s.title}</strong><small>{s.captures[viewport] ? '已有实现截图' : '待补实现截图'}</small></button></div>;
            })}</div></div></section>)}</section>}
        {mode === 'gallery' && <section className="gallery">{filtered.map(s => <button key={s.id} onClick={() => { choose(s); setMode('compare'); }}><div><img src={s.reference} alt={s.title} loading="lazy" /></div><code>{s.id}</code><strong>{s.title}</strong><span>{s.category}</span></button>)}{!filtered.length && <p>没有匹配的截图。</p>}</section>}
      </>}
      <footer className="desk-footer"><span>参考 ≠ 实现 · 有截图 ≠ 验收通过</span><span>仅限本地审计</span></footer>
    </main>
    <dialog ref={dialog} className="zoom" onClose={() => setZoom(undefined)} onClick={e => { if (e.target === dialog.current) setZoom(undefined); }}><header><strong>{zoom?.title}</strong><button autoFocus aria-label="关闭原图" onClick={() => setZoom(undefined)}>关闭 ×</button></header>{zoom && <img src={zoom.src} alt={zoom.title} />}</dialog>
  </div>;
}

function Product() {
  return <main className="product"><span className="brand-mark">T</span><h1>TJUClaw</h1><p>校园行动智能体 · 工程初始化</p><code>v{version}</code><p>校园服务与任务执行尚未接入。</p>{import.meta.env.DEV && <a href="http://127.0.0.1:1421">打开本地审计工作台 ↗</a>}</main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode>{import.meta.env.MODE === 'audit' ? <Audit /> : <Product />}</StrictMode>);
