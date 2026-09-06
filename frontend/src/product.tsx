import { useRef, useState, type MouseEvent } from 'react';
import { ArrowUp, Check, ChevronLeft, ChevronRight, CircleDashed, Contrast, FileText, Moon, Palette, Search, Sparkles, Sun, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { setAppearance, useAppearance, type Accent, type Mode } from './lib/appearance';
import './product.css';

const modes = [
  { value: 'system' as const, label: '跟随系统', Icon: Contrast },
  { value: 'light' as const, label: '浅色', Icon: Sun },
  { value: 'dark' as const, label: '深色', Icon: Moon },
];
const accents = [{ value: 'mono' as const, label: '黑白' }, { value: 'blue' as const, label: '蓝色' }];
const samples = [
  { title: '读书笔记', description: '把零散的想法，整理成清晰的文字。', color: 'mint', icon: FileText },
  { title: '周末出行', description: '给计划留一点空间，也留一点期待。', color: 'orange', icon: Sparkles },
  { title: '灵感收集', description: '值得留下的，下次都能找到。', color: 'graphite', icon: CircleDashed },
];

function LivePreview() {
  const [expanded, setExpanded] = useState(false);
  return <section className="live-preview" aria-label="主题实时预览">
    <header className="preview-heading"><span>实时预览</span><span className="preview-indicator">随你而变</span></header>
    <div className="preview-window">
      <header className="preview-toolbar"><span className="mini-mark"><Sparkles size={16} /></span><strong>TJUClaw</strong><span className="sample-label">示例</span></header>
      <div className="preview-conversation">
        <div className="sample-user">把今天的灵感整理成一份笔记。</div>
        <div className="sample-answer"><span className="answer-mark"><Sparkles size={18} /></span><div><strong>让好想法，有个好归处。</strong><p>把零散记录归类，留下重点，<br />也留下一点继续探索的空间。</p></div></div>
        <button className="file-preview" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <span className="file-icon"><FileText size={22} /></span><span><strong>今日灵感.md</strong><small>Markdown · 主题预览示例</small></span><ChevronRight size={17} className={expanded ? 'rotated' : ''} />
        </button>
        {expanded && <div className="sample-document"><strong>今日灵感</strong><p>先记录，再整理。<br />让每一个值得保留的想法，都有下一步。</p></div>}
      </div>
      <div className="preview-composer"><span>从一个想法开始</span><span className="send-sample" aria-hidden="true"><ArrowUp size={19} /></span></div>
    </div>
    <p className="preview-footnote">仅展示界面样式，不代表真实任务执行。</p>
  </section>;
}

export default function Product() {
  const appearance = useAppearance();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [notice, setNotice] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const profileRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  function openAppearance(event: MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    setOpen(true);
  }
  function changeMode(mode: Mode) { setAppearance({ mode }); setNotice('外观已应用'); }
  function changeAccent(accent: Accent) { setAppearance({ accent }); setNotice('强调色已应用'); }

  return <div className="product-app">
    <Dialog open={open} onOpenChange={setOpen}>
      <main className="home-page">
        <header className="home-toolbar">
          <Button ref={profileRef} variant="floating" size="icon" className="profile-button" aria-label="打开外观设置" aria-haspopup="dialog" onClick={openAppearance}>TJ</Button>
          <span className="wordmark">TJUClaw</span>
          <div className="home-actions"><Button variant="floating" size="icon" aria-label={showSearch ? '关闭搜索' : '搜索示例'} aria-expanded={showSearch} onClick={() => { setShowSearch(!showSearch); setQuery(''); }}><Search size={23} /></Button><Button variant="floating" size="icon" aria-label="设置外观" aria-haspopup="dialog" onClick={openAppearance}><Palette size={23} /></Button></div>
        </header>
        <div className="home-heading"><div><p>一个轻一点的开始</p><h1>你的想法，下一步。</h1></div><span>界面预览</span></div>
        {showSearch && <div className="sample-search"><Search size={19} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索示例" aria-label="搜索示例" /><Button size="icon" variant="ghost" aria-label="清空搜索" onClick={() => setQuery('')}><X size={16} /></Button></div>}
        <ul className="conversation-list">{samples.filter(s => `${s.title}${s.description}`.includes(query)).map(({ title, description, color, icon: Icon }) => <li key={title}><span className={`sample-avatar ${color}`}><Icon size={25} strokeWidth={1.7} /></span><div><strong>{title}</strong><p>{description}</p></div><span className="list-sample">示例</span></li>)}</ul>
        {query && !samples.some(s => `${s.title}${s.description}`.includes(query)) && <p className="no-results">没有匹配的示例，换个关键词试试。</p>}
        <footer className="home-footer">少一点打扰，多一点完成。<Button variant="ghost" aria-haspopup="dialog" onClick={openAppearance}><Palette size={16} />调整外观</Button></footer>
      </main>

      <DialogContent className="appearance-panel"
        onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); (openerRef.current || profileRef.current)?.focus(); }}>
        <header className="appearance-header">
          <DialogClose asChild><Button variant="floating" size="icon" aria-label="返回主页面"><ChevronLeft size={26} strokeWidth={1.8} /></Button></DialogClose>
          <div><DialogTitle ref={titleRef} tabIndex={-1}>外观</DialogTitle><DialogDescription>让这里，成为你喜欢的样子。</DialogDescription></div>
          <span className="settings-label">个性化设置</span>
        </header>
        <div className="appearance-body">
          <div className="appearance-options">
            <fieldset className="appearance-fieldset"><legend>显示模式</legend><div className="mode-options">
              {modes.map(({ value, label, Icon }) => <label className="appearance-choice" key={value}>
                <input type="radio" name="mode" value={value} checked={appearance.mode === value} onChange={() => changeMode(value)} />
                <span className="choice-tile">{value === 'system' ? <span className="system-mode-icon" aria-hidden="true" /> : <Icon className={`mode-icon mode-icon-${value}`} size={29} strokeWidth={1.8} aria-hidden="true" />}<Check className="selection-check" size={13} aria-hidden="true" /></span><span className="choice-label">{label}</span>
              </label>)}
            </div><p className="mode-explanation">{appearance.mode === 'system' ? `随设备自动切换，当前为${appearance.resolved === 'dark' ? '深色' : '浅色'}。` : `${appearance.mode === 'dark' ? '深色' : '浅色'}外观，与你的设备设置无关。`}</p></fieldset>
            <fieldset className="appearance-fieldset accent-fieldset"><legend>强调色</legend><div className="accent-options">
              {accents.map(({ value, label }) => <label className="appearance-choice" key={value}>
                <input type="radio" name="accent" value={value} checked={appearance.accent === value} onChange={() => changeAccent(value)} />
                <span className="choice-tile"><span className={`accent-dot accent-${value}`} /><Check className="selection-check" size={13} aria-hidden="true" /></span><span className="choice-label">{label}</span>
              </label>)}
            </div></fieldset>
            <div className="appearance-note"><span className="note-icon"><Check size={13} /></span>{appearance.canPersist
              ? <p>偏好自动保存在这台设备上。<br />不用保存，下次打开依然是熟悉的样子。</p>
              : <p>外观已在本次会话中生效。<br />浏览器限制了存储，关闭后可能需要重新设置。</p>}</div>
            <Button variant="ghost" className="reset-appearance" onClick={() => { setAppearance({ mode: 'system', accent: 'mono' }); setNotice('已恢复默认外观'); }}>恢复默认</Button>
            <span className="sr-only" role="status">{notice}</span>
          </div>
          <LivePreview />
        </div>
        <footer className="appearance-footer"><span>TJUClaw <span className="footer-dot">·</span> 为日常留白</span><span>外观设置</span></footer>
      </DialogContent>
    </Dialog>
  </div>;
}
