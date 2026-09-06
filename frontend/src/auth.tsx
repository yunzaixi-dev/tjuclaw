import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleHelp, Mail, Moon, ShieldCheck, Sparkles, Sun } from 'lucide-react';
import { Button } from './components/ui/button';
import { setAppearance, useAppearance } from './lib/appearance';
import { actionPath, AuthError, authRequest, describeError, flowMessages, flowPath, logout, readSession, safeAuthRedirect, validateFlow, type AuthKind, type Flow, type IdentitySession } from './lib/auth';
import './product.css';
import './auth.css';

function Shell({ children }: { children: ReactNode }) {
  const appearance = useAppearance();
  return <div className="auth-shell">
    <header className="auth-toolbar">
      <a href="/" className="auth-wordmark" aria-label="TJUClaw 首页"><span className="auth-mini-mark"><Sparkles size={19} /></span>TJUClaw</a>
      <Button variant="floating" size="icon" aria-label={appearance.resolved === 'dark' ? '切换浅色外观' : '切换深色外观'}
        onClick={() => setAppearance({ mode: appearance.resolved === 'dark' ? 'light' : 'dark' })}>
        {appearance.resolved === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </Button>
    </header>
    <main className="auth-main">{children}</main>
    <footer className="auth-footer"><span>少一点打扰，多一点完成。</span><a href="/auth/help"><CircleHelp size={14} />登录帮助</a></footer>
  </div>;
}

function Heading({ title, children, mail = false }: { title: string; children: ReactNode; mail?: boolean }) {
  return <header className="auth-heading">
    <span className={`auth-symbol ${mail ? 'auth-symbol-mail' : ''}`}>{mail ? <Mail size={30} strokeWidth={1.5} /> : <Sparkles size={31} strokeWidth={1.6} />}</span>
    <h1>{title}</h1><div className="auth-description">{children}</div>
  </header>;
}

function Problem({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="auth-problem" role="alert"><p>{message}</p>{retry && <Button variant="ghost" onClick={retry}>重新开始<ArrowRight size={15} /></Button>}</div>;
}

function Welcome() {
  return <section className="auth-card auth-welcome">
    <Heading title="你的校园生活，下一步。"><p>从一个目标开始，<br />让 TJUClaw 帮你把事情往前推进。</p></Heading>
    <a className="auth-primary-link" href="/auth/login"><Mail size={19} />使用邮箱登录<ArrowRight size={19} /></a>
    <p className="auth-switch">第一次来到这里？<a href="/auth/registration">创建账号</a></p>
    <div className="auth-assurance"><ShieldCheck size={16} /><span>使用邮箱验证码，无需设置密码。</span></div>
  </section>;
}

const copy = {
  login: { title: '欢迎回来。', description: '用你的邮箱，继续上次的旅程。', submit: '继续', code: '验证并登录' },
  registration: { title: '从这里开始。', description: '一个邮箱，就是你的起点。', submit: '创建账号', code: '验证并创建账号' },
  verification: { title: '验证你的邮箱。', description: '确认这个邮箱属于你，保障账号安全。', submit: '发送验证码', code: '验证邮箱' },
};

function FlowScreen({ kind }: { kind: AuthKind }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState('');
  const [verified, setVerified] = useState(false);
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sent = !!flow?.ui.nodes.some(n => n.attributes.name === 'code' && n.attributes.type !== 'hidden');
  const csrf = flow?.ui.nodes.find(n => n.attributes.name === 'csrf_token')?.attributes.value;

  function acceptFlow(next: Flow) {
    validateFlow(next);
    setFlow(next);
    const address = next.ui.nodes.find(n => ['identifier', 'traits.email', 'email'].includes(n.attributes.name || ''))?.attributes.value;
    if (address) setEmail(address);
    history.replaceState(null, '', `/auth/${kind}?flow=${encodeURIComponent(next.id)}`);
  }

  useEffect(() => {
    const controller = new AbortController();
    const id = new URLSearchParams(location.search).get('flow') || undefined;
    authRequest<Flow>(flowPath(kind, id), { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) {
        acceptFlow(next);
        if (next.state === 'passed_challenge') setVerified(true);
      }
    }).catch(async err => {
      if (controller.signal.aborted) return;
      if (err instanceof AuthError && err.body.error?.id === 'session_already_available') {
        location.replace('/auth/complete');
        return;
      }
      setError(describeError(err));
      setFatal(true);
    });
    return () => controller.abort();
  // A restart explicitly creates a new flow; never replay an old code automatically.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, attempt]);

  useEffect(() => {
    if (flow) inputRef.current?.focus();
  }, [sent, flow?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (!flow) return;
    const update = () => setExpired(Date.now() >= Date.parse(flow.expires_at));
    update();
    const timer = window.setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [flow]);

  function restart() {
    if (lock.current) return;
    history.replaceState(null, '', `/auth/${kind}`);
    setFlow(null); setCode(''); setError(''); setFatal(false); setExpired(false); setNotice(''); setCooldown(0);
    setAttempt(value => value + 1);
  }

  async function submit(event?: FormEvent, resend = false) {
    event?.preventDefault();
    if (!flow || lock.current || expired || resend && cooldown > 0) return;
    lock.current = true;
    setBusy(true); setError(''); setNotice('');
    const payload: Record<string, unknown> = { method: 'code', csrf_token: csrf };
    if (sent && !resend) payload.code = code;
    else if (resend && kind !== 'verification') payload.resend = 'code';
    if (kind === 'registration') payload.traits = { email: email.trim() };
    else if (kind === 'login') payload.identifier = email.trim();
    else if (!sent || resend) payload.email = email.trim();
    try {
      const next = await authRequest<Flow>(actionPath(flow, kind), { method: 'POST', body: JSON.stringify(payload) });
      if (next.ui) {
        acceptFlow(next);
        if (next.state === 'passed_challenge') setVerified(true);
        else if (flowMessages(next).some(message => message.type === 'error')) {
          setCode('');
          setError('验证码不正确、已使用或已失效，请检查最新邮件后重试。');
          inputRef.current?.focus();
        }
        else {
          setCode('');
          setCooldown(30);
          setNotice(resend ? '已请求重新发送，请查看最新邮件。' : '请查看邮箱中的验证码。');
        }
      } else {
        const session = await readSession();
        if (session) location.assign('/auth/complete');
        else { setError('验证已提交，但尚未建立登录会话。请重新登录。'); setFatal(true); }
      }
    } catch (err) {
      if (err instanceof AuthError && err.body.ui) {
        const next = err.body as Flow;
        try { validateFlow(next); }
        catch { setError('认证服务返回了异常内容，请重新开始。'); setFatal(true); return; }
        acceptFlow(next);
        setCode('');
        if (flowMessages(next).some(m => m.type === 'error')) {
          setError(sent ? '验证码不正确、已使用或已失效，请检查最新邮件后重试。' : '无法继续，请检查邮箱格式，或尝试登录已有账号。');
        } else if (resend && next.ui.nodes.some(n => n.attributes.name === 'code')) {
          // Kratos returns an updated flow with HTTP 400 for a successful resend.
          setCooldown(30);
          setNotice('已请求重新发送，请查看最新邮件。');
        } else setError('验证未完成，请重试。');
        inputRef.current?.focus();
      } else if (err instanceof AuthError && err.body.redirect_browser_to) {
        try { location.assign(safeAuthRedirect(err.body.redirect_browser_to)); }
        catch { setError('认证返回了无法识别的地址，请重新开始。'); setFatal(true); }
      } else {
        setError(describeError(err));
        setFatal(err instanceof AuthError && [403, 404, 410].includes(err.status));
      }
    } finally { lock.current = false; setBusy(false); }
  }

  if (verified) return <section className="auth-card">
    <Heading title="邮箱已验证。"><p>你已完成邮箱验证，可以继续使用 TJUClaw。</p></Heading>
    <a href="/auth/complete" className="auth-primary-link">继续<ArrowRight size={18} /></a>
  </section>;

  return <section className="auth-card">
    <a className="auth-back" href="/"><ArrowLeft size={17} />返回</a>
    <Heading mail={sent} title={sent ? '查看你的邮箱。' : copy[kind].title}>
      {sent ? <p>若该邮箱可用于本次验证，验证码将发送至<br /><strong className="auth-email">{email || '你填写的邮箱'}</strong></p>
        : <p>{copy[kind].description}</p>}
    </Heading>
    {!flow && !fatal && <div className="auth-skeleton" role="status" aria-label="正在准备安全登录"><span /><span /></div>}
    {flow && !fatal && !expired && <form onSubmit={submit} aria-busy={busy}>
      <label className="auth-field-label" htmlFor="auth-input">{sent ? '邮箱验证码' : '邮箱地址'}</label>
      <div className={`auth-input-wrap ${error ? 'auth-input-error' : ''}`}>
        {!sent && <Mail size={19} aria-hidden="true" />}
        <input ref={inputRef} id="auth-input" name={sent ? 'code' : 'email'} type={sent ? 'text' : 'email'}
          className={sent ? 'auth-code-input' : ''} autoComplete={sent ? 'one-time-code' : 'email'}
          inputMode={sent ? 'numeric' : 'email'} autoCapitalize="none" spellCheck={false}
          required maxLength={sent ? 6 : 254} pattern={sent ? '[0-9]{6}' : undefined}
          placeholder={sent ? '000000' : 'you@example.com'} value={sent ? code : email}
          aria-invalid={!!error} aria-describedby={error ? 'auth-form-error' : 'auth-field-hint'}
          onPaste={event => {
            if (!sent) return;
            const pasted = event.clipboardData.getData('text').replace(/\s/g, '');
            if (/^[0-9]{6}$/.test(pasted)) { event.preventDefault(); setCode(pasted); setError(''); }
          }}
          readOnly={busy} onChange={event => {
            if (sent) setCode(event.target.value.replace(/\s/g, '').replace(/[^0-9]/g, '').slice(0, 6));
            else setEmail(event.target.value);
            setError('');
          }} />
      </div>
      <p id="auth-field-hint" className="auth-field-hint">{sent ? '输入邮件中的 6 位数字，可直接粘贴。' : '仅用于账号登录与安全验证，无需设置密码。'}</p>
      {error && <p className="auth-inline-error" role="alert" id="auth-form-error">{error}</p>}
      <Button className="auth-submit" type="submit" disabled={busy || sent && code.length !== 6}>
        {busy ? '正在安全验证…' : sent ? copy[kind].code : copy[kind].submit}
        {!busy && <ArrowRight size={18} />}
      </Button>
      {sent && <div className="auth-code-actions">
        <Button variant="ghost" disabled={busy || cooldown > 0} onClick={() => void submit(undefined, true)}>
          {cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送验证码'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={restart}>更换邮箱</Button>
      </div>}
      <p className="auth-status" role="status">{notice}</p>
    </form>}
    {(fatal || expired) && <Problem message={expired ? '这次验证已过期，请重新开始。' : error} retry={restart} />}
    {!sent && kind !== 'verification' && <p className="auth-switch">{kind === 'login' ? '还没有账号？' : '已经有账号？'}
      <a href={kind === 'login' ? '/auth/registration' : '/auth/login'}>{kind === 'login' ? '创建账号' : '登录'}</a></p>}
    {sent && <p className="auth-delivery-help">没有收到？检查垃圾邮件，或稍等片刻后重发。<br />请勿向任何人提供验证码。</p>}
  </section>;
}

function SessionScreen({ complete = false }: { complete?: boolean }) {
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const next = await readSession(controller.signal);
        if (controller.signal.aborted) return;
        if (!next) { location.replace('/auth/login'); return; }
        setSession(next);
        setError('');
      } catch (err) { if (!controller.signal.aborted) setError(describeError(err)); }
    }
    void check();
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void check(), 60000);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [attempt]);

  async function signOut() {
    setBusy(true);
    try { await logout(); }
    catch (err) {
      if (err instanceof AuthError && err.status === 401) { location.replace('/auth/logged-out'); return; }
      setError(describeError(err)); setBusy(false);
    }
  }
  return <section className="auth-card">
    <Heading title={session ? complete ? '准备好了。' : '你的账号。' : '正在确认登录。'}>
      <p>{session ? complete ? '登录成功，欢迎来到 TJUClaw。' : '登录与账号安全，清晰可见。' : '正在安全地恢复你的会话。'}</p>
    </Heading>
    {error && <Problem message={error} retry={() => { setError(''); setAttempt(n => n + 1); }} />}
    {!session && !error && <div className="auth-skeleton" role="status" aria-label="正在确认登录状态"><span /><span /></div>}
    {session && <>
      <div className="auth-account"><span className="auth-account-avatar">{session.email.slice(0, 1).toUpperCase()}</span>
        <div><strong className="auth-email">{session.email}</strong><small><ShieldCheck size={14} />{session.email_verified ? '邮箱已验证' : '邮箱待验证'}</small></div>
        {session.email_verified && <Check size={18} />}
      </div>
      {complete ? <a className="auth-primary-link" href="/app">进入 TJUClaw<ArrowRight size={18} /></a>
        : <div className="auth-account-note"><p>账号已连接。</p><p>校园任务与工作空间功能仍在开发中，不会在这里展示虚构的执行结果。</p><a href="/preview/appearance">查看外观设置<ChevronRight size={15} /></a></div>}
      {!session.email_verified && <a className="auth-primary-link" href="/auth/verification">验证邮箱<ArrowRight size={18} /></a>}
      <Button variant="ghost" className="auth-logout" disabled={busy} onClick={signOut}>{busy ? '正在退出…' : '退出登录'}</Button>
    </>}
  </section>;
}

function Help() {
  return <section className="auth-card">
    <a className="auth-back" href="/auth/login"><ArrowLeft size={17} />返回登录</a>
    <Heading title="让登录简单一点。"><p>关于邮箱登录，你可能想知道这些。</p></Heading>
    <div className="auth-help-list">
      <details open><summary>没有收到验证码？</summary><p>检查邮箱地址和垃圾邮件文件夹。邮件可能稍有延迟，请等待片刻再重发，并使用最新收到的验证码。</p></details>
      <details><summary>需要记住密码吗？</summary><p>不需要。TJUClaw 只使用邮箱验证码登录。已有账号选择登录，第一次使用请先创建账号。</p></details>
      <details><summary>验证过期或换了浏览器？</summary><p>返回登录页重新开始。请在发起验证的浏览器中输入验证码，不要复制验证页面地址到其他设备。</p></details>
      <details><summary>无法访问原来的邮箱？</summary><p>先通过邮箱服务商恢复邮箱访问权限。TJUClaw 不会通过跳过邮箱验证的方式授予账号访问权限。</p></details>
      <details><summary>如何保护账号？</summary><p>不要分享验证码。在公共设备上使用后退出登录。账号邮箱不等于教务系统授权，登录不会自动授予校园服务访问权。</p></details>
    </div>
  </section>;
}

function ErrorScreen() {
  return <section className="auth-card">
    <Heading title="这一步没能完成。"><p>验证可能已过期，或当前会话发生了变化。<br />重新登录即可再次尝试。</p></Heading>
    <a href="/auth/login" className="auth-primary-link">重新登录<ArrowRight size={18} /></a>
    <p className="auth-delivery-help">请勿分享带有验证参数的页面地址。</p>
  </section>;
}

export default function Auth() {
  const path = location.pathname;
  let content: ReactNode;
  if (path === '/auth/login') content = <FlowScreen kind="login" />;
  else if (path === '/auth/registration') content = <FlowScreen kind="registration" />;
  else if (path === '/auth/verification') content = <FlowScreen kind="verification" />;
  else if (path === '/auth/complete') content = <SessionScreen complete />;
  else if (path === '/app') content = <SessionScreen />;
  else if (path === '/auth/help') content = <Help />;
  else if (path === '/auth/logged-out') content = <section className="auth-card"><Heading title="已安全退出。"><p>下次需要时，TJUClaw 仍在这里。</p></Heading><a href="/auth/login" className="auth-primary-link">重新登录<ArrowRight size={18} /></a></section>;
  else if (path === '/') content = <Welcome />;
  else content = <ErrorScreen />;
  return <Shell>{content}</Shell>;
}
