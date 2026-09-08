import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Clock, Info, Loader2, Moon, RefreshCw, Sparkles, Sun, User } from 'lucide-react';
import { Button } from './components/ui/button';
import { setAppearance, useAppearance } from './lib/appearance';
import { logout, readSession, type IdentitySession } from './lib/auth';
import { createTask, describeTaskError, getTask, listTasks, type Task } from './lib/tasks';
import './product.css';
import './workspace.css';

export default function Workspace() {
  const appearance = useAppearance();
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState('');

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [loggingOut, setLoggingOut] = useState(false);

  const activeUserIdRef = useRef<string | null>(null);
  const closingRef = useRef(false);
  const sessionSeqRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const listSeqRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailSeqRef = useRef(0);
  const createAbortRef = useRef<AbortController | null>(null);
  const createSeqRef = useRef(0);

  function resetPrivateState(clearPrompt = true) {
    listAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    createAbortRef.current?.abort();
    listSeqRef.current++;
    detailSeqRef.current++;
    createSeqRef.current++;

    setTasks([]);
    setSelectedTaskId(null);
    setSelectedTask(null);
    setTasksError('');
    setTasksLoading(false);
    setDetailLoading(false);
    setDetailError('');
    setSubmitError('');
    setSubmitting(false);
    if (clearPrompt) {
      setPrompt('');
    }
  }

  // Session management
  useEffect(() => {
    let unmounted = false;
    let inFlightController: AbortController | null = null;

    async function checkSession() {
      if (closingRef.current) return;
      inFlightController?.abort();
      const controller = new AbortController();
      inFlightController = controller;
      const seq = ++sessionSeqRef.current;

      try {
        const next = await readSession(controller.signal);
        if (unmounted || controller.signal.aborted || seq !== sessionSeqRef.current) return;
        if (!next) {
          resetPrivateState(true);
          location.replace('/auth/login');
          return;
        }

        if (activeUserIdRef.current && activeUserIdRef.current !== next.id) {
          resetPrivateState(true);
        }
        activeUserIdRef.current = next.id;
        setSession(next);
      } catch {
        if (!unmounted && !controller.signal.aborted && seq === sessionSeqRef.current) {
          resetPrivateState(true);
          location.replace('/auth/login');
        }
      } finally {
        if (!unmounted && !controller.signal.aborted && seq === sessionSeqRef.current) {
          setSessionLoading(false);
        }
      }
    }

    void checkSession();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void checkSession(), 60000);

    return () => {
      unmounted = true;
      inFlightController?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
      resetPrivateState(false);
    };
  }, []);

  function loadTasks() {
    if (closingRef.current) return;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const seq = ++listSeqRef.current;
    const currentUserId = activeUserIdRef.current;

    setTasksLoading(true);
    setTasksError('');

    listTasks(controller.signal)
      .then(res => {
        if (controller.signal.aborted || seq !== listSeqRef.current || currentUserId !== activeUserIdRef.current) {
          return;
        }
        setTasks(res);
        // If a task is already selected, make sure it's in list or refresh detail
        if (selectedTaskId) {
          const found = res.find(t => t.id === selectedTaskId);
          if (found) setSelectedTask(found);
        } else if (res.length > 0) {
          // Default select the first task
          selectTask(res[0].id);
        }
      })
      .catch(err => {
        if (controller.signal.aborted || seq !== listSeqRef.current || currentUserId !== activeUserIdRef.current) {
          return;
        }
        const msg = describeTaskError(err);
        setTasksError(msg);
        if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 401) {
          resetPrivateState(true);
          location.replace('/auth/login');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === listSeqRef.current && currentUserId === activeUserIdRef.current) {
          setTasksLoading(false);
        }
      });
  }

  function selectTask(id: string) {
    if (closingRef.current) return;
    setSelectedTaskId(id);
    const cached = tasks.find(t => t.id === id);
    if (cached) {
      setSelectedTask(cached);
    }

    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    const seq = ++detailSeqRef.current;
    const currentUserId = activeUserIdRef.current;

    setDetailLoading(true);
    setDetailError('');

    getTask(id, controller.signal)
      .then(task => {
        if (controller.signal.aborted || seq !== detailSeqRef.current || currentUserId !== activeUserIdRef.current) {
          return;
        }
        setSelectedTask(task);
      })
      .catch(err => {
        if (controller.signal.aborted || seq !== detailSeqRef.current || currentUserId !== activeUserIdRef.current) {
          return;
        }
        setDetailError(describeTaskError(err));
        if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 401) {
          resetPrivateState(true);
          location.replace('/auth/login');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === detailSeqRef.current && currentUserId === activeUserIdRef.current) {
          setDetailLoading(false);
        }
      });
  }

  const loadSessionTasks = useEffectEvent(() => loadTasks());
  const sessionID = session?.id;
  useEffect(() => {
    if (!sessionID) return;
    loadSessionTasks();
    return () => {
      listAbortRef.current?.abort();
    };
  }, [sessionID]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || closingRef.current) return;

    const trimmed = prompt.trim();
    if (!trimmed) return;

    createAbortRef.current?.abort();
    const controller = new AbortController();
    createAbortRef.current = controller;
    const seq = ++createSeqRef.current;
    const currentUserId = activeUserIdRef.current;

    setSubmitting(true);
    setSubmitError('');

    try {
      const newTask = await createTask(trimmed, controller.signal);
      if (controller.signal.aborted || seq !== createSeqRef.current || currentUserId !== activeUserIdRef.current) {
        return;
      }
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      listSeqRef.current++;
      detailSeqRef.current++;
      setTasksLoading(false);
      setDetailLoading(false);
      setTasks(prev => [newTask, ...prev]);
      setSelectedTaskId(newTask.id);
      setSelectedTask(newTask);
      setPrompt('');
    } catch (err) {
      if (controller.signal.aborted || seq !== createSeqRef.current || currentUserId !== activeUserIdRef.current) {
        return;
      }
      setSubmitError(describeTaskError(err));
      if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 401) {
        resetPrivateState(true);
        location.replace('/auth/login');
      }
    } finally {
      if (!controller.signal.aborted && seq === createSeqRef.current && currentUserId === activeUserIdRef.current) {
        setSubmitting(false);
      }
    }
  }

  async function handleLogout() {
    if (closingRef.current) return;
    closingRef.current = true;
    sessionSeqRef.current++;
    activeUserIdRef.current = null;
    resetPrivateState(true);
    setSession(null);
    setLoggingOut(true);
    try {
      await logout();
      resetPrivateState(true);
      location.replace('/auth/login');
    } catch {
      resetPrivateState(true);
      location.replace('/auth/login');
    }
  }

  if (sessionLoading || !session) {
    return (
      <div className="workspace-shell">
        <main className="workspace-main">
          <div className="workspace-loading-box" role="status" aria-label="正在确认登录状态">
            <Loader2 className="animate-spin" size={24} />
            <span style={{ marginLeft: 12 }}>正在加载任务工作区…</span>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div className="workspace-header-inner">
          <a href="/workspace" className="workspace-brand">
            <span className="workspace-brand-badge">
              <Sparkles size={18} />
            </span>
            <span className="workspace-title">任务工作区</span>
          </a>

          <div className="workspace-header-actions">
            <Button
              variant="floating"
              size="icon"
              aria-label={appearance.resolved === 'dark' ? '切换浅色外观' : '切换深色外观'}
              onClick={() => setAppearance({ mode: appearance.resolved === 'dark' ? 'light' : 'dark' })}
            >
              {appearance.resolved === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </Button>
            <a href="/app" className="workspace-nav-link" aria-label="返回账号中心">
              <User size={16} />
              <span>账号中心</span>
            </a>
            <Button
              variant="ghost"
              size="default"
              disabled={loggingOut}
              onClick={handleLogout}
              aria-label="退出登录"
            >
              {loggingOut ? '正在退出…' : '退出登录'}
            </Button>
          </div>
        </div>
      </header>

      <main className="workspace-main">
        <div className="workspace-state-banner">
          <div className="workspace-banner-content">
            <div className="workspace-banner-text">
              <Info size={18} className="workspace-banner-icon" />
              <span>
                <strong>草稿捕获阶段：</strong>
                任务已保存到服务器；执行功能尚未接入。
              </span>
            </div>
            <a href="/app" className="workspace-banner-link">
              查看账号与设置
              <ArrowLeft size={14} style={{ transform: 'rotate(180deg)' }} />
            </a>
          </div>
        </div>

        <div className="workspace-content-grid">
          {/* Left Column: Create task & Task List */}
          <div className="workspace-panel">
            <h1 className="workspace-panel-title">任务工作区</h1>
            <p className="workspace-panel-desc">
              记录和整理你需要推进的校园任务与目标。
            </p>

            <form className="workspace-form" onSubmit={handleSubmit}>
              <div className="workspace-form-group">
                <label htmlFor="task-prompt" className="workspace-form-label">
                  任务目标
                </label>
                <div className="workspace-textarea-wrap">
                  <textarea
                    id="task-prompt"
                    name="task-prompt"
                    className="workspace-textarea"
                    placeholder="描述你想要完成的事情或目标（如：整理下周计算机网络课程的复习提纲）…"
                    value={prompt}
                    onChange={e => {
                      setPrompt(e.target.value);
                      if (submitError) setSubmitError('');
                    }}
                    disabled={submitting}
                    rows={4}
                    maxLength={4000}
                    required
                  />
                </div>
                <div className="workspace-form-meta">
                  <span>支持 1~4000 字符</span>
                  <span>{prompt.length}/4000</span>
                </div>
              </div>

              {submitError && (
                <div className="workspace-inline-error" role="alert">
                  {submitError}
                </div>
              )}

              <div className="workspace-form-actions">
                <Button
                  type="submit"
                  variant="solid"
                  disabled={submitting || !prompt.trim()}
                  aria-label="保存任务"
                >
                  {submitting ? '正在保存…' : '保存任务'}
                </Button>
              </div>
            </form>

            <div className="workspace-tasks-header">
              <span className="workspace-tasks-heading">已捕获目标</span>
              <span className="workspace-tasks-count">
                {tasks.length} 条记录
              </span>
            </div>

            {tasksLoading && tasks.length === 0 && (
              <div className="workspace-loading-box" role="status">
                <Loader2 className="animate-spin" size={18} />
                <span style={{ marginLeft: 8 }}>加载列表中…</span>
              </div>
            )}

            {tasksError && (
              <div className="workspace-inline-error" role="alert" style={{ marginBottom: 12 }}>
                {tasksError}
                <Button
                  variant="ghost"
                  size="default"
                  onClick={loadTasks}
                  style={{ marginTop: 8, padding: '4px 8px', height: 'auto' }}
                >
                  <RefreshCw size={14} /> 重试
                </Button>
              </div>
            )}

            {!tasksLoading && tasks.length === 0 && !tasksError && (
              <div className="workspace-empty-state">
                <p>还没有保存的任务</p>
                <small>在上方输入目标并点击“保存任务”开始记录。</small>
              </div>
            )}

            <ul className="workspace-task-list" role="list" aria-label="任务列表">
              {tasks.map(t => {
                const isSelected = t.id === selectedTaskId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={`workspace-task-item ${isSelected ? 'active' : ''}`}
                      onClick={() => selectTask(t.id)}
                      aria-current={isSelected ? 'true' : undefined}
                    >
                      <div className="workspace-task-item-top">
                        <span className="workspace-task-item-title">{t.title}</span>
                        <span className="workspace-badge-draft">已保存</span>
                      </div>
                      <span className="workspace-task-item-snippet">{t.prompt}</span>
                      <span className="workspace-task-item-time">
                        {new Date(t.created_at).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Right Column: Task Detail */}
          <div className="workspace-panel workspace-detail-panel">
            {detailLoading && !selectedTask ? (
              <div className="workspace-loading-box" role="status">
                <Loader2 className="animate-spin" size={24} />
                <span style={{ marginLeft: 12 }}>正在加载任务详情…</span>
              </div>
            ) : selectedTask ? (
              <div>
                <div className="workspace-detail-header">
                  <div>
                    <h2 className="workspace-detail-title">{selectedTask.title}</h2>
                    <div className="workspace-detail-meta">
                      <span className="workspace-badge-draft">已保存</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Clock size={13} />
                        {new Date(selectedTask.created_at).toLocaleString('zh-CN', {
                          year: 'numeric',
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="workspace-detail-content">
                  <div className="workspace-detail-section-title">详细要求与提示</div>
                  <div className="workspace-prompt-box">
                    {selectedTask.prompt}
                  </div>

                  <div className="workspace-detail-disclaimer">
                    <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div>
                      <strong>关于任务状态说明：</strong>
                      <p style={{ marginTop: 4 }}>
                        当前系统处于第一阶段（任务目标捕获），该任务处于“已保存 (draft)”状态。后台执行引擎与自主规划模型开发中，暂不提供完成打勾、自动重试或生成式执行结果。
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="workspace-detail-empty">
                <Sparkles size={36} strokeWidth={1.5} style={{ opacity: 0.5 }} />
                <p>未选择任务</p>
                <small>从左侧列表中选择一个任务查看详情，或新建一个任务目标。</small>
              </div>
            )}

            {detailError && (
              <div className="workspace-inline-error" role="alert" style={{ marginTop: 16 }}>
                {detailError}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
