const $ = (id) => document.getElementById(id);
const state = {
  signatures: {},
  drafts: new Map(),
  dashboard: null,
  selectedId: localStorage.getItem("clone-ai:selected-session"),
  refreshTimer: null,
  scrollPositions: new Map(),
  openDisclosures: new Map(),
  disclosureScrollPositions: new Map(),
  schedules: [],
  settings: null,
  providers: [],
  memories: [],
  settingsSection: "audit",
};
const icon = (name) => name === "spark"
  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z"/></svg>`
  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`;
const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const time = (value) => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const day = (value) => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(value));
const api = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  if (window.CLONE_AI_TOKEN) headers.set("Authorization", `Bearer ${window.CLONE_AI_TOKEN}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error || "本地请求失败。");
  return body;
};
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
let sidebarResizeActive = false;
function applySidebarWidth(value, persist = true) { const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 400)); const width = Math.round(Math.max(SIDEBAR_MIN, Math.min(max, value))); document.querySelector(".app-shell").style.setProperty("--sidebar-width", `${width}px`); const handle = $("sidebar-resizer"); handle.setAttribute("aria-valuenow", String(width)); if (persist) localStorage.setItem("clone-ai:sidebar-width", String(width)); }
function restoreSidebarWidth() { const saved = Number(localStorage.getItem("clone-ai:sidebar-width")); applySidebarWidth(Number.isFinite(saved) ? saved : 278, false); }
const statusMeta = (status) => {
  if (status === "waiting_approval") return { label: "等待确认", className: "waiting", dot: "waiting" };
  if (status === "completed") return { label: "已验证", className: "completed", dot: "completed" };
  if (status === "failed" || status === "cancelled") return { label: "需要处理", className: "needs-attention", dot: "needs-attention" };
  return { label: "正在推进", className: "running", dot: "running" };
};
function announce(message, error = false) { const node = $("notice"); node.textContent = message; node.className = `notice visible${error ? " error" : ""}`; clearTimeout(node.timer); node.timer = setTimeout(() => node.className = "notice", 3200); }
function sessionMarkup(session) { const status = statusMeta(session.status); return `<div class="session-item"><button class="session" type="button" data-session="${escape(session.id)}" aria-current="${String(session.id === state.selectedId)}"><span class="status-dot ${status.dot}"></span><span class="session-copy"><span class="session-title">${escape(session.title)}</span><span class="session-meta">${escape(session.preview || status.label)}</span></span></button><button class="session-delete" type="button" data-delete-session="${escape(session.id)}" aria-label="删除会话">×</button></div>`; }
function renderSessions(sessions) {
  const signature = JSON.stringify([state.selectedId, sessions.map((session) => [session.id, session.title, session.preview, session.status, session.updatedAt])]);
  if (state.signatures.sessions === signature) return;
  state.signatures.sessions = signature;
  if (!sessions.length) { $("session-list").innerHTML = `<div class="empty-sessions">还没有会话。<br/>从下方开始第一件事。</div>`; return; }
  const todayKey = new Date().toDateString();
  const today = sessions.filter((session) => new Date(session.updatedAt).toDateString() === todayKey);
  const earlier = sessions.filter((session) => new Date(session.updatedAt).toDateString() !== todayKey);
  $("session-list").innerHTML = `${today.length ? `<div class="session-group">今天</div>${today.map(sessionMarkup).join("")}` : ""}${earlier.length ? `<div class="session-group">更早</div>${earlier.map(sessionMarkup).join("")}` : ""}`;
}
function renderSchedules(schedules) { state.schedules = schedules; const signature = JSON.stringify(schedules); if (state.signatures.schedules === signature) return; state.signatures.schedules = signature; $("schedule-count").textContent = String(schedules.filter((schedule) => schedule.enabled).length); $("schedule-list").innerHTML = schedules.length ? schedules.map((schedule) => `<div class="schedule-row"><div><b>${escape(schedule.query)}</b><span>${escape(schedule.description)} · ${schedule.enabled ? "已启用" : "已暂停"}</span></div><button class="schedule-toggle" type="button" data-schedule-toggle="${escape(schedule.id)}" data-schedule-enabled="${String(!schedule.enabled)}">${schedule.enabled ? "暂停" : "启用"}</button></div>`).join("") : `<div class="schedule-empty">还没有定时任务。<br/>可以按每天、每周、每月、每年或 Cron 创建。</div>`; }
function agentRoleLabel(role) { return ({ direct: "主执行", research: "调研", draft: "交付", review: "复核", external: "外部执行" }[role] || role); }
function providerLabel(id) { return ({ "codex-cli": "Codex CLI", "claude-code": "Claude Code", pi: "Pi" }[id] || id); }
function renderSettings(settings, providers) { state.settings = settings; state.providers = providers; const signature = JSON.stringify([settings, providers]); if (state.signatures.settings === signature) return; state.signatures.settings = signature; const providerById = new Map(providers.map((provider) => [provider.id, provider])); const missing = providers.filter((provider) => !provider.installed); $("install-missing-providers").disabled = missing.length === 0; $("install-missing-providers").textContent = missing.length ? `自动安装缺失项 (${missing.length})` : "Provider 已就绪"; $("provider-registry").innerHTML = providers.map((provider) => `<article class="provider-card"><div><b>${escape(provider.title)}</b><p>${escape(provider.purpose)}${provider.version ? ` · ${escape(provider.version)}` : ""}</p></div>${provider.installed ? `<span class="provider-status">已检测</span>` : `<button class="provider-install" type="button" data-install-provider="${escape(provider.id)}">安装</button>`}</article>`).join(""); $("agent-settings-list").innerHTML = settings.agents.map((agent) => { const options = providers.map((provider) => `<option value="${escape(provider.id)}" ${agent.providerId === provider.id ? "selected" : ""} ${provider.installed ? "" : "disabled"}>${escape(providerLabel(provider.id))}${provider.installed ? "" : "（未安装）"}</option>`).join(""); const provider = providerById.get(agent.providerId); return `<article class="agent-setting"><div><h3>${escape(agent.title)}<span>${escape(agentRoleLabel(agent.role))}</span></h3><p>${escape(agent.description)}</p><small>${escape(agent.purpose)}</small></div><select class="agent-provider-select" data-agent-provider="${escape(agent.id)}" aria-label="选择 ${escape(agent.title)} 的 Provider" ${provider?.installed ? "" : "disabled"}>${options}</select><label class="agent-switch" title="${agent.required ? "此角色必须保持启用" : agent.enabled ? "关闭此角色" : "启用此角色"}"><input type="checkbox" data-agent-toggle="${escape(agent.id)}" ${agent.enabled ? "checked" : ""} ${agent.required ? "disabled" : ""}/><span></span></label></article>`; }).join(""); }
function renderSituation(situation, config) { state.situation = situation; state.config = config; const signature = JSON.stringify([situation, config]); if (state.signatures.situation === signature) return; state.signatures.situation = signature; const overdue = situation.overdue || []; const dueSoon = situation.dueSoon || []; const goals = situation.activeGoals || []; const boundaries = situation.selfModel || []; const rows = []; if (overdue.length) rows.push(`<div class="settings-card"><h4>已逾期 (${overdue.length})</h4>${overdue.slice(0, 6).map((item) => `<p>${escape(item.title)} · 应于 ${escape(String(item.dueAt || "").slice(0, 10))}</p>`).join("")}</div>`); if (dueSoon.length) rows.push(`<div class="settings-card"><h4>即将到期 (${dueSoon.length})</h4>${dueSoon.slice(0, 6).map((item) => `<p>${escape(item.title)} · ${escape(String(item.dueAt || "").slice(0, 10))}</p>`).join("")}</div>`); if (goals.length) rows.push(`<div class="settings-card"><h4>进行中的目标 (${goals.length})</h4>${goals.slice(0, 6).map((item) => `<p>${escape(item.title)}</p>`).join("")}</div>`); if (boundaries.length) rows.push(`<div class="settings-card"><h4>你声明过的边界 (${boundaries.length})</h4>${boundaries.slice(0, 6).map((item) => `<p>${escape(item.statement)}</p>`).join("")}</div>`); const observed = (situation.observations || []); if (observed.length) rows.push(`<div class="settings-card"><h4>观察来源</h4>${observed.map((item) => `<p>${escape(item.connectorId)} · ${item.error ? `读取失败：${escape(item.error)}` : `${item.count} 条`}</p>`).join("")}</div>`); $("situation-overview").innerHTML = rows.length ? rows.join("") : `<div class="memory-empty">还没有记录任何目标、承诺或观察。分身只会依据你确认过的内容行动。</div>`; const paths = config.paths || {}; $("config-paths").innerHTML = `<h4>本地数据</h4><p>数据目录：${escape(paths.dataDirectory || "-")}</p><p>项目运行目录：${escape(paths.workspaceRuntimeDirectory || "-")}</p><p>Provider 配置：${escape(paths.providersFile || "-")}</p><p>记忆：${escape(paths.memoryDirectory || "-")}</p><span class="settings-value">仅本机</span>`; if (document.activeElement !== $("config-workspace")) $("config-workspace").value = config.config?.workspacePath || ""; }

function renderConnectors(connectors) { state.connectors = connectors; const signature = JSON.stringify(connectors); if (state.signatures.connectors === signature) return; state.signatures.connectors = signature; $("connector-list").innerHTML = connectors.length ? connectors.map((connector) => `<article class="agent-setting"><div><h3>${escape(connector.id)}</h3><p>${escape(connector.target || "（未设置目录）")}</p><small>只读观察，绝不获得执行权限</small></div><label class="agent-switch" title="${connector.enabled ? "停用此来源" : "启用此来源"}"><input type="checkbox" data-connector-toggle="${escape(connector.id)}" ${connector.enabled ? "checked" : ""}/><span></span></label><button class="schedule-toggle" type="button" data-connector-remove="${escape(connector.id)}">移除</button></article>`).join("") : `<div class="memory-empty">还没有观察来源。添加一个目录后，分身才能知道你没主动告诉它的事。</div>`; }

async function saveConnectors(connectors, message) { try { await api("/api/connectors", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectors }) }); await refresh(); announce(message); } catch (error) { announce(error.message, true); } }

async function addConnector() { const target = window.prompt("要让分身观察哪个目录？（只读）"); if (!target || !target.trim()) return; const existing = state.connectors || []; const id = `files:${existing.length + 1}`; await saveConnectors([...existing, { id, enabled: true, target: target.trim() }], "已添加观察来源。"); }

async function setConnectorEnabled(id, enabled) { const next = (state.connectors || []).map((connector) => connector.id === id ? { ...connector, enabled } : connector); await saveConnectors(next, enabled ? "观察来源已启用。" : "观察来源已停用。"); }

async function removeConnector(id) { await saveConnectors((state.connectors || []).filter((connector) => connector.id !== id), "观察来源已移除。"); }

async function saveWorkspace() { const workspacePath = $("config-workspace").value.trim(); if (!workspacePath) { announce("请填写工作目录。", true); return; } try { await api("/api/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspacePath }) }); await refresh(); announce("工作目录已保存。"); } catch (error) { announce(error.message, true); } }

function renderAudit(sessions) { const signature = JSON.stringify(sessions.map((session) => [session.id, session.title, session.status, session.updatedAt])); if (state.signatures.audit === signature) return; state.signatures.audit = signature; $("audit-session-list").innerHTML = sessions.length ? sessions.map((session) => `<article class="audit-session"><div><b>${escape(session.title)}</b><span>${escape(statusMeta(session.status).label)} · ${time(session.updatedAt)}</span></div><button class="audit-open" type="button" data-open-audit-run="${escape(session.id)}">查看记录</button></article>`).join("") : `<div class="memory-empty">还没有可查看的执行记录。</div>`; }
function renderMemoryCandidates(candidates) {
  if (!candidates || !candidates.length) { $("memory-candidates").innerHTML = ""; return; }
  $("memory-candidates").innerHTML = `<h4>待确认的记忆候选（${candidates.length}）</h4><p class="candidates-hint">后台 Agent 从已完成任务中提炼了这些候选；提升后会写入本地记忆库，拒绝则丢弃。</p>${candidates.map((candidate) => `<article class="memory-card candidate-card"><textarea readonly aria-label="候选记忆内容">${escape(candidate.summary)}</textarea><div class="memory-meta"><span>${escape(candidate.type || "fact")} · ${escape(candidate.confidence)} 置信度</span>${candidate.sensitivity ? `<span>${escape(candidate.sensitivity)}</span>` : ""}<span>引用 ${(candidate.sourceEvidenceIds || []).length} 条证据</span></div><div class="candidate-actions"><button class="approve" type="button" data-promote-candidate="${escape(candidate.id)}">提升为记忆</button><button class="secondary" type="button" data-reject-candidate="${escape(candidate.id)}">拒绝</button></div></article>`).join("")}`;
}
async function decideCandidate(id, action) { try { await api(`/api/memory/candidates/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refresh(); announce(action === "promote" ? "候选已提升为正式记忆。" : "候选已拒绝。"); } catch (error) { announce(error.message, true); } }
function renderMemorySearch(results) { $("memory-search-results").innerHTML = results.length ? results.map((match) => `<article class="memory-match"><div><b>${escape(match.summary)}</b><small>匹配：${escape((match.matchedTerms || []).join("、") || "相关上下文")}</small></div><span>${Math.round(match.score * 100)}%</span></article>`).join("") : `<div class="memory-empty">没有找到会被当前检索规则召回的使用中记忆。分身和子 Agent 看到的就是这些结果。</div>`; }

/**
 * The opportunity strip: what the twin noticed without being asked.
 *
 * Cards render above the conversation, not buried in a settings panel —
 * "the twin proactively found you" has to mean you see it where you already
 * are. Accept creates a run (the backend plans and queues it); dismiss
 * removes the card. Both record the decision in the journal.
 *
 * 机会卡片：分身不等人提问时发现的东西。
 *
 * 卡片渲染在对话区上方，而不是埋在设置面板里——“分身主动找你”必须意味着你在
 * 本来就在的地方看到它。接受会创建 Run（后端会规划并入队）；拒绝会移除卡片。
 * 两个决定都记入 Journal。
 */
function renderOpportunities(cards) {
  state.opportunities = cards;
  const signature = JSON.stringify(cards);
  if (state.signatures.opportunities === signature) return;
  state.signatures.opportunities = signature;
  const strip = $("opportunity-strip");
  if (!cards.length) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = cards.slice(0, 4).map((card) => `<article class="opportunity-card">
    <div class="opportunity-head"><span class="opportunity-source">${escape(opportunitySourceLabel(card.source))}</span><b>${escape(card.title)}</b></div>
    <p class="opportunity-why">${escape(card.whyNow)}</p>
    <p class="opportunity-proposal">${escape(card.proposedResult)}</p>
    <div class="opportunity-actions">
      <button class="approve" type="button" data-accept-opportunity="${escape(card.id)}">接受并开始</button>
      <button class="secondary" type="button" data-dismiss-opportunity="${escape(card.id)}">不需要</button>
    </div>
  </article>`).join("");
}

function opportunitySourceLabel(source) { return { deadline: "临近承诺", failed_task: "任务跟进", neglected_goal: "目标提醒", observation: "新观察" }[source] || "机会"; }

async function decideOpportunity(id, action) {
  try {
    const result = await api(`/api/opportunities/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    state.signatures.opportunities = null;
    await refresh({ scrollToBottom: false });
    announce(action === "accept" ? `已接受。任务 ${String(result.runId || "").slice(0, 8)} 已开始准备。` : "已记录这个决定。");
  } catch (error) { announce(error.message, true); }
}

const MEMORY_TYPES = [["preference", "偏好"], ["fact", "事实"], ["decision", "决定"], ["procedure", "流程"], ["commitment", "承诺"]];
const MEMORY_SENSITIVITIES = [["private", "私有"], ["public", "公开"], ["secret", "机密"]];
function options(pairs, selected) { return pairs.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join(""); }

function renderLibrary(library) {
  state.library = library;
  // Never redraw a field the owner is typing into: the .md content is
  // long-form prose, and losing a half-written paragraph to a background poll
  // is the fastest way to make an editor untrustworthy. The guard is limited
  // to text entry — a focused button is not an edit in progress, and treating
  // it as one would freeze the panel until the owner clicked elsewhere.
  const activeElement = document.activeElement;
  const editing = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
  if (editing && activeElement.closest("#library-list, #library-new-content, #library-new-summary, .memory-tools")) return;
  const signature = JSON.stringify(library);
  if (state.signatures.library === signature) return;
  state.signatures.library = signature;
  const stats = library.stats || { active: 0, archived: 0, total: 0, pending: 0, contentDirectory: "" };
  $("library-overview").innerHTML = `<article class="memory-stat"><b>${stats.active}</b><span>使用中</span></article><article class="memory-stat"><b>${stats.archived}</b><span>已归档</span></article><article class="memory-stat"><b>${stats.pending}</b><span>待确认候选</span></article><article class="memory-stat file-stat"><b>.md</b><span>${escape(stats.contentDirectory || "-")}</span></article>`;
  const memories = library.memories || [];
  $("library-list").innerHTML = memories.length ? memories.map((item) => `<article class="memory-card library-card" data-library-card="${escape(item.id)}">
    <input class="library-summary" type="text" value="${escape(item.summary)}" data-library-summary="${escape(item.id)}" aria-label="记忆摘要"/>
    <textarea class="library-content" data-library-content="${escape(item.id)}" aria-label="记忆正文" rows="4">${escape(item.content || "")}</textarea>
    <div class="memory-meta">
      <select data-library-type="${escape(item.id)}" aria-label="类型">${options(MEMORY_TYPES, item.type)}</select>
      <select data-library-sensitivity="${escape(item.id)}" aria-label="敏感度">${options(MEMORY_SENSITIVITIES, item.sensitivity)}</select>
      <select class="memory-status" data-library-status="${escape(item.id)}" aria-label="状态"><option value="active" ${item.status === "active" ? "selected" : ""}>使用中</option><option value="archived" ${item.status === "archived" ? "selected" : ""}>已归档</option></select>
      <span>${escape(item.confidence)} 置信度</span>
      <span>召回 ${item.accessCount || 0} 次</span>
      ${item.sourceRunId && item.sourceRunId !== "owner" ? `<button class="memory-source" type="button" data-open-memory-source="${escape(item.sourceRunId)}">查看来源</button>` : `<span>由你写入</span>`}
      <span class="library-file">${escape(item.id)}.md</span>
      <button class="memory-save" type="button" data-save-library="${escape(item.id)}">保存</button>
    </div>
  </article>`).join("") : `<div class="memory-empty">记忆库还是空的。写下一条你希望分身长期记住的偏好、边界或事实——它会成为一个你随时可以打开和修改的 .md 文件。</div>`;
  if (library.syncError) announce(`磁盘上的记忆文件读取失败：${library.syncError}`, true);
}

async function saveLibraryMemory(id) {
  const pick = (attribute) => document.querySelector(`[data-library-${attribute}="${CSS.escape(id)}"]`);
  const body = {
    summary: pick("summary").value,
    content: pick("content").value,
    type: pick("type").value,
    sensitivity: pick("sensitivity").value,
    status: pick("status").value,
  };
  const button = document.querySelector(`[data-save-library="${CSS.escape(id)}"]`);
  if (button) button.disabled = true;
  try {
    await api(`/api/memory/governed/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.signatures.library = null;
    await refresh();
    announce("记忆已保存，对应的 .md 文件也已更新。");
  } catch (error) { announce(error.message, true); } finally { if (button) button.disabled = false; }
}

async function createLibraryMemory() {
  const summary = $("library-new-summary").value.trim();
  if (summary.length < 3) { announce("请写下一条至少三个字的摘要。", true); return; }
  const button = $("library-create");
  button.disabled = true;
  try {
    await api("/api/memory/governed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary, content: $("library-new-content").value.trim(), type: $("library-new-type").value, sensitivity: $("library-new-sensitivity").value }) });
    $("library-new-summary").value = "";
    $("library-new-content").value = "";
    state.signatures.library = null;
    await refresh();
    announce("已写入记忆库。");
  } catch (error) { announce(error.message, true); } finally { button.disabled = false; }
}

function renderContext(context) {
  state.context = context;
  const signature = JSON.stringify(context);
  if (state.signatures.context === signature) return;
  state.signatures.context = signature;
  const compactions = context.compactions || [];
  // entriesOutOfContext is the headline: it is the part of the conversation the
  // model can no longer see but that search_history can still reach.
  $("context-overview").innerHTML = `<article class="memory-stat"><b>${context.messageEntries || 0}</b><span>历史消息</span></article><article class="memory-stat"><b>${compactions.length}</b><span>压缩次数</span></article><article class="memory-stat"><b>${context.entriesOutOfContext || 0}</b><span>已压缩出上下文</span></article><article class="memory-stat file-stat"><b>jsonl</b><span>${escape(context.directory || "-")}</span></article>`;
  $("context-compactions").innerHTML = compactions.length ? `<h4>压缩记录</h4><p class="candidates-hint">每一次压缩都写下了一段摘要，被摘要掉的原文仍在磁盘上，可以被搜索回来。</p>${compactions.map((item) => `<article class="memory-card"><div class="memory-meta"><span>${escape(String(item.at || "").slice(0, 16).replace("T", " "))}</span><span>压缩前约 ${item.tokensBefore || 0} tokens</span></div><p class="context-summary">${escape(item.summaryPreview || "（没有摘要文本）")}</p></article>`).join("")}` : `<div class="memory-empty">还没有发生过压缩。对话仍然完整地在模型上下文里。</div>`;
  const conversations = context.conversations || [];
  $("context-conversations").innerHTML = conversations.length ? `<h4>对话（${conversations.length}）</h4>${conversations.map((item) => `<article class="memory-card"><div class="memory-meta">${item.active ? `<span class="context-active">当前对话</span>` : ""}<span>${item.messages} 条消息</span><span>${time(item.updatedAt)}</span></div><p class="context-summary">${escape(item.preview || "（没有预览）")}</p></article>`).join("")}` : "";
}

function renderContextSearch(excerpts) {
  $("context-search-results").innerHTML = excerpts.length ? excerpts.map((item) => `<article class="memory-match context-match"><div><b>${escape(item.speaker)} · ${escape(String(item.at || "").slice(0, 16).replace("T", " "))}${item.outOfContext ? " · 已压缩出上下文" : ""}</b><small>${escape(item.excerpt)}</small></div><span>${Math.round(item.score * 100)}%</span></article>`).join("") : `<div class="memory-empty">完整历史里没有匹配的内容。</div>`;
}

async function searchContextHistory(query) { try { renderContextSearch((await api(`/api/context/search?q=${encodeURIComponent(query)}`)).excerpts || []); } catch (error) { announce(error.message, true); } }
function welcomeMarkup() { return `<div class="welcome"><div class="welcome-copy"><div class="welcome-mark">${icon("spark")}</div><h2>今天，想让我替你推进什么？</h2><p>我会先拆解、准备和验证；如果下一步会影响外部世界，我会停下来等你确认。</p><div class="suggestions"><button class="suggestion" data-suggestion="整理今天需要推进的事情">整理今天需要推进的事情</button><button class="suggestion" data-suggestion="为下周的产品发布准备计划">为下周的产品发布准备计划</button><button class="suggestion" data-suggestion="比较三个可执行方案并给我建议">比较三个可执行方案并给我建议</button></div></div></div>`; }
function richText(value) {
  return escape(value)
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => `<div class="md-code-wrap"><button class="md-copy" type="button" data-copy-code>复制</button><pre class="md-code"><code>${code.replace(/^\n+|\n+$/g, "")}</code></pre></div>`)
    .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}
function messageMarkup(message) { const clone = message.role === "clone"; const tone = message.tone ? ` ${message.tone}` : ""; const collapsible = clone && message.text.length > 480; return `<article class="message ${clone ? "clone" : "person"}"><div class="avatar ${clone ? "clone" : ""}">${clone ? "C" : "你"}</div><div class="message-body"><div class="message-heading"><b>${clone ? "clone-ai" : "你"}</b><time>${time(message.occurredAt)}</time></div>${clone ? `<div class="clone-card${tone}"><div class="clone-text${collapsible ? " collapsible collapsed" : ""}">${richText(message.text)}</div>${collapsible ? `<button class="clone-expand" type="button" data-expand>展开全部</button>` : ""}</div>` : `<div class="message-copy">${escape(message.text)}</div>`}</div></article>`; }
function displayAgentTitle(agent) { return agent.title; }
function displayAgentDetail(agent) { const provider = agent.providerId ? `${providerLabel(agent.providerId)} · ` : ""; return provider + (agent.status === "completed" ? "已提交可验证证据" : (agent.summary || "正在按任务边界推进")); }
function disclosureOpen(session, name, fallback = false) { return state.openDisclosures.get(session.id)?.get(name) ?? fallback; }
function planMarkup(session) { if (!session.plan) return ""; const fallback = session.status === "waiting_approval" || !["completed", "failed", "cancelled"].includes(session.status); const open = disclosureOpen(session, "plan", fallback) ? " open" : ""; return `<details class="activity-card plan-card" data-disclosure="plan"${open}><summary class="activity-summary">${icon("spark")}<b>执行计划</b><span>${session.plan.steps.length} 步</span></summary><p class="plan-summary">${escape(session.plan.summary)}</p><div class="plan-steps">${session.plan.steps.map((step, index) => `<div class="plan-step"><span class="plan-step-index">${index + 1}</span><b>${escape(step.title)}</b><span>${step.delegated ? "委派执行" : step.risk === "read_only" ? "直接处理" : "需确认"}</span></div>`).join("")}</div></details>`; }
function agentsMarkup(session) { if (!session.subagents.length) return ""; const completed = session.subagents.filter((agent) => agent.status === "completed").length; const fallback = session.status === "waiting_approval" || !["completed", "failed", "cancelled"].includes(session.status); const open = disclosureOpen(session, "agents", fallback) ? " open" : ""; return `<details class="activity-card" data-disclosure="agents"${open}><summary class="activity-summary">${icon("spark")}<b>Agent 协作</b><span>${completed}/${session.subagents.length} 已完成</span></summary><div class="agent-list">${session.subagents.map((agent) => { const status = statusMeta(agent.status); return `<div class="agent-row"><span class="status-dot ${status.dot}"></span><div><strong>${escape(displayAgentTitle(agent))}</strong><small>${escape(displayAgentDetail(agent))}</small></div><span class="agent-status">${escape(status.label)}</span></div>`; }).join("")}</div></details>`; }
function approvalMarkup(session) { if (!session.approvals.length) return ""; return `<section class="approval-card"><div class="approval-kicker">需要你的决定</div><h2>是否继续执行外部动作？</h2><p>${escape(session.approvals[0].description)}</p><div class="approval-actions"><button class="approve" type="button" data-approve="${escape(session.id)}">确认并继续</button><button class="secondary" type="button" data-reject="${escape(session.id)}">拒绝</button></div></section>`; }
function recalledMemoryMarkup(session) { const memories = session.recalledMemories || []; if (!memories.length) return ""; return `<details class="activity-card" data-disclosure="memory"><summary class="activity-summary">${icon("spark")}<b>本次任务使用的 Memory</b><span>${memories.length} 条</span></summary><div class="agent-list">${memories.map((memory) => `<div class="agent-row"><div><strong>${escape(memory.summary)}</strong><small>匹配：${escape((memory.matchedTerms || []).join("、") || "相关上下文")} · ${Math.round((memory.score || 0) * 100)}%</small></div></div>`).join("")}</div></details>`; }
function evidenceMarkup(session) { return session.evidenceCount ? `<div class="evidence">${icon("check")}已记录 ${session.evidenceCount} 条可验证证据</div>` : ""; }
function traceMarkup(session) { const trace = session.trace || session.activity || []; if (!trace.length) return ""; const open = disclosureOpen(session, "trace") ? " open" : ""; return `<details class="activity-card" data-disclosure="trace"${open}><summary class="activity-summary">${icon("check")}<b>本地执行轨迹</b><span>${trace.length} 条</span></summary><div class="trace" data-scroll-region="trace">${trace.map((item, index) => `<div class="trace-row"><b><span class="trace-sequence">#${item.sequence ?? index + 1}</span>${escape(item.label)}</b><p>${time(item.occurredAt)} · ${escape(item.detail)}</p></div>`).join("")}</div></details>`; }
function setTopbar(session) { if (!session) { $("session-title").textContent = "新的对话"; $("session-subtitle").textContent = "从一个清晰的意图开始"; $("session-status").textContent = "准备就绪"; $("session-status").className = "status-pill"; return; } const status = statusMeta(session.status); $("session-title").textContent = session.title; $("session-subtitle").textContent = `${session.preview} · 更新于 ${time(session.updatedAt)}`; $("session-status").textContent = status.label; $("session-status").className = `status-pill ${status.className}`; }
const SCROLL_BOTTOM_THRESHOLD = 28;
function rememberCurrentScroll() {
  if (!state.selectedId) return;
  const viewport = $("conversation");
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  state.scrollPositions.set(state.selectedId, {
    top: viewport.scrollTop,
    anchor: maxTop - viewport.scrollTop <= SCROLL_BOTTOM_THRESHOLD ? "bottom" : "offset",
  });
}
function rememberDisclosureScrolls() {
  if (!state.selectedId) return;
  const positions = state.disclosureScrollPositions.get(state.selectedId) || new Map();
  document.querySelectorAll("#conversation-inner [data-scroll-region]").forEach((region) => {
    positions.set(region.dataset.scrollRegion, region.scrollTop);
  });
  state.disclosureScrollPositions.set(state.selectedId, positions);
}
function rememberDisclosureScroll(event) {
  const region = event.target;
  if (!(region instanceof HTMLElement) || !region.dataset.scrollRegion || !state.selectedId) return;
  const positions = state.disclosureScrollPositions.get(state.selectedId) || new Map();
  positions.set(region.dataset.scrollRegion, region.scrollTop);
  state.disclosureScrollPositions.set(state.selectedId, positions);
}
function rememberDisclosure(event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.disclosure || !state.selectedId) return;
  const disclosures = state.openDisclosures.get(state.selectedId) || new Map();
  disclosures.set(details.dataset.disclosure, details.open);
  state.openDisclosures.set(state.selectedId, disclosures);
}
function restoreSessionScroll(id, { scrollToBottom = false } = {}) {
  const saved = scrollToBottom ? { top: 0, anchor: "bottom" } : state.scrollPositions.get(id) || { top: 0, anchor: "bottom" };
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    const viewport = $("conversation");
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const top = saved.anchor === "bottom" ? maxTop : Math.min(saved.top, maxTop);
    viewport.scrollTop = top;
    state.scrollPositions.set(id, { top, anchor: saved.anchor });
  });
}
function restoreDisclosureScrolls(id) {
  const positions = state.disclosureScrollPositions.get(id);
  if (!positions) return;
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    document.querySelectorAll("#conversation-inner [data-scroll-region]").forEach((region) => {
      const top = positions.get(region.dataset.scrollRegion);
      if (top !== undefined) region.scrollTop = Math.min(top, Math.max(0, region.scrollHeight - region.clientHeight));
    });
  });
}
function renderSession(session) { setTopbar(session); const signature = session ? JSON.stringify(session) : "welcome"; if (state.signatures.conversation === signature) return; state.signatures.conversation = signature; const content = $("conversation-inner"); if (!session) { content.innerHTML = welcomeMarkup(); $("conversation").scrollTop = 0; return; } content.innerHTML = `<div class="day-divider">${day(session.updatedAt)}</div>${session.messages.filter((message) => String(message.text ?? "").trim()).map(messageMarkup).join("")}${recalledMemoryMarkup(session)}${planMarkup(session)}${agentsMarkup(session)}${evidenceMarkup(session)}${approvalMarkup(session)}${traceMarkup(session)}`; restoreDisclosureScrolls(session.id); requestAnimationFrame(updateScrollBottom); }
async function selectSession(id, { quiet = false, scrollToBottom = false } = {}) { if (state.selectedId !== id) { if (state.selectedId) state.drafts.set(state.selectedId, $("query").value); $("query").value = state.drafts.get(id) || ""; resizeComposer(); rememberCurrentScroll(); rememberDisclosureScrolls(); } state.selectedId = id; localStorage.setItem("clone-ai:selected-session", id); renderSessions(state.dashboard?.sessions || []); try { const session = await api(`/api/sessions/${encodeURIComponent(id)}`); renderSession(session); restoreSessionScroll(id, { scrollToBottom }); } catch (error) { if (!quiet) announce(error.message, true); state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); renderSession(null); } }
async function refresh({ preserveScroll = true, scrollToBottom = false } = {}) { if (preserveScroll) { rememberCurrentScroll(); rememberDisclosureScrolls(); } try { const [dashboard, schedules, settings, agents, candidates, situation, config, connectors, library, context, opportunities] = await Promise.all([api("/api/dashboard"), api("/api/schedules"), api("/api/settings"), api("/api/agents"), api("/api/memory/candidates"), api("/api/situation"), api("/api/config"), api("/api/connectors"), api("/api/memory/governed"), api("/api/context"), api("/api/opportunities")]); state.dashboard = dashboard; renderSchedules(schedules.schedules || []); renderSettings(settings, agents.providers || []); renderAudit(dashboard.sessions || []); renderLibrary(library); renderOpportunities(opportunities.opportunities || []); renderContext(context); renderMemoryCandidates(candidates.candidates || []); renderSituation(situation, config); renderConnectors(connectors.connectors || []); const sessions = state.dashboard.sessions || []; if (!state.selectedId || !sessions.some((session) => session.id === state.selectedId)) state.selectedId = sessions[0]?.id || null; renderSessions(sessions); if (state.selectedId) await selectSession(state.selectedId, { quiet: true, scrollToBottom }); else renderSession(null); requestAnimationFrame(() => { $("startup-screen").classList.add("ready"); document.querySelector(".app-shell").classList.add("ready"); }); } catch (error) { announce(error.message, true); const startupTip = document.querySelector("#startup-screen .startup-card span"); if (startupTip && !$("startup-screen").classList.contains("ready")) startupTip.textContent = `连接本地运行时失败：${error.message}（自动重试中…）`; } }
async function createSession(query) { const button = $("submit"); button.disabled = true; rememberCurrentScroll();
  // The message and a live reply card appear before the request is sent. A model
  // call can take many seconds, and until now the composer kept the text and the
  // conversation showed nothing, so the app looked frozen mid-thought.
  // 消息与实时回复卡片在请求发出之前就出现。模型调用可能耗时数秒，而此前输入框保留原文、
  // 会话区毫无变化，应用看起来就像在思考中卡住了。
  $("query").value = ""; resizeComposer();
  const inner = $("conversation-inner");
  const welcome = inner.querySelector(".welcome"); if (welcome) inner.innerHTML = "";
  inner.insertAdjacentHTML("beforeend", `<div class="message you"><div class="avatar you">你</div><div class="message-body"><div class="message-heading"><b>你</b><time>${time(new Date().toISOString())}</time></div><div class="you-bubble">${escape(query)}</div></div></div>`);
  const card = document.createElement("div"); card.className = "message clone";
  card.innerHTML = `<div class="avatar clone">C</div><div class="message-body"><div class="message-heading"><b>clone-ai</b><time>${time(new Date().toISOString())}</time></div><div class="clone-card"><div class="clone-text" data-streaming="1"></div></div></div>`;
  inner.appendChild(card);
  const target = card.querySelector(".clone-text");
  $("conversation").scrollTop = $("conversation").scrollHeight;

  let reply = ""; let result = null;
  try {
    const headers = { "content-type": "application/json" };
    if (window.CLONE_AI_TOKEN) headers.Authorization = `Bearer ${window.CLONE_AI_TOKEN}`;
    const response = await fetch("/api/main-agent/stream", { method: "POST", headers, body: JSON.stringify({ text: query }) });
    if (!response.ok || !response.body) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || `请求失败：${response.status}`); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial frame stays buffered.
      // SSE 帧以空行分隔；不完整的帧留在缓冲区等待后续数据。
      let split;
      while ((split = buffer.indexOf(String.fromCharCode(10, 10))) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "delta") { reply += payload.delta; target.textContent = reply; $("conversation").scrollTop = $("conversation").scrollHeight; }
        else if (event === "done") { result = payload; }
        else if (event === "failed") { throw new Error(payload.error); }
      }
    }
    if (!result) throw new Error("连接在回复完成前中断。");
    state.drafts.delete(state.selectedId);
    // Re-render the finished reply so links and code blocks are formatted; the
    // streaming view stays plain text because partial markdown renders wrong.
    // 回复完成后重新渲染，让链接与代码块获得格式；流式过程保持纯文本，因为不完整的
    // Markdown 会渲染错乱。
    target.removeAttribute("data-streaming"); target.innerHTML = richText(reply);
    const firstRun = result.newRuns?.[0];
    if (firstRun) { state.selectedId = firstRun.id; state.scrollPositions.set(firstRun.id, { top: 0, anchor: "bottom" }); localStorage.setItem("clone-ai:selected-session", firstRun.id); }
    await refresh({ preserveScroll: true, scrollToBottom: true });
    announce(firstRun ? "Main Agent 已提交计划，正在推进。" : "Main Agent 已回复（未创建任务）。");
  } catch (error) {
    // The typed text is restored so a failed send never loses what was written.
    // 恢复已输入的文本，使一次失败的发送绝不丢失所写内容。
    if (!reply) { $("query").value = query; resizeComposer(); card.remove(); }
    else { target.removeAttribute("data-streaming"); target.innerHTML = richText(reply); }
    announce(error.message, true);
  } finally { button.disabled = false; }
}

async function approve(id) { const button = document.querySelector(`[data-approve="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { const result = await api(`/api/runs/${encodeURIComponent(id)}/approve`, { method: "POST" }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce(result.status === "completed" ? "已完成并验证结果。" : "已记录确认，继续处理中。" ); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
async function reject(id) { const button = document.querySelector(`[data-reject="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { await api(`/api/runs/${encodeURIComponent(id)}/reject`, { method: "POST" }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce("已拒绝这次外部动作。"); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
function resizeComposer() { const input = $("query"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 132)}px`; }
function renderScheduleOptions() { const kind = $("schedule-kind").value; const options = $("schedule-options"); $("schedule-time").hidden = kind === "interval"; $("schedule-time").required = kind !== "interval"; if (kind === "interval") { options.innerHTML = `<label>每隔</label><input id="schedule-interval-value" type="number" min="1" max="10080" value="30" aria-label="间隔时长"/><select id="schedule-interval-unit" aria-label="间隔单位"><option value="1">分钟</option><option value="60">小时</option></select><span class="schedule-cron-help">按固定间隔触发，例如每隔 5 分钟；首次触发要等一个间隔，客户端关闭期间错过的不会补跑。</span>`; return; } if (kind === "weekly") { options.innerHTML = `<label>在这些日子执行：</label>${["日", "一", "二", "三", "四", "五", "六"].map((day, index) => `<label><input type="checkbox" name="schedule-weekday" value="${index}" ${index === 1 ? "checked" : ""}/>周${day}</label>`).join("")}`; return; } if (kind === "monthly") { options.innerHTML = `<label>每月 <input id="schedule-day" type="number" min="1" max="31" value="1"/> 日</label>`; return; } if (kind === "yearly") { options.innerHTML = `<label>每年 <select id="schedule-month">${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1} 月</option>`).join("")}</select><input id="schedule-day" type="number" min="1" max="31" value="1"/> 日</label>`; return; } options.innerHTML = `<span class="schedule-cron-help">每天在所选时间触发；如果客户端稍后启动，当天会补触发一次。</span>`; }
function openSchedules() { $("schedule-modal").setAttribute("aria-hidden", "false"); renderScheduleOptions(); $("schedule-query").focus(); }
function closeSchedules() { $("schedule-modal").setAttribute("aria-hidden", "true"); }
function selectSettingsSection(section) { state.settingsSection = section; document.querySelectorAll("[data-settings-section]").forEach((button) => button.setAttribute("aria-current", String(button.dataset.settingsSection === section))); document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== section; }); }
function openSettings() { selectSettingsSection(state.settingsSection); $("settings-modal").setAttribute("aria-hidden", "false"); }
function closeSettings() { $("settings-modal").setAttribute("aria-hidden", "true"); }
async function createSchedule(query) { const button = $("schedule-create"); const kind = $("schedule-kind").value; const body = { query, kind, time: $("schedule-time").value }; if (kind === "weekly") body.weekdays = [...document.querySelectorAll('input[name="schedule-weekday"]:checked')].map((input) => Number(input.value)); if (kind === "monthly" || kind === "yearly") body.dayOfMonth = Number($("schedule-day").value); if (kind === "yearly") body.month = Number($("schedule-month").value); if (kind === "interval") body.intervalMinutes = Math.max(1, Math.floor(Number($("schedule-interval-value").value) || 0)) * Number($("schedule-interval-unit").value); button.disabled = true; try { await api("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); $("schedule-query").value = ""; await refresh(); announce("定时任务已保存到本地运行时。"); } catch (error) { announce(error.message, true); } finally { button.disabled = false; } }
async function setScheduleEnabled(id, enabled) { try { await api(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); await refresh(); announce(enabled ? "定时任务已启用。" : "定时任务已暂停。"); } catch (error) { announce(error.message, true); } }
async function updateAgent(id, update, message) { try { await api(`/api/settings/agents/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(update) }); await refresh(); announce(message); } catch (error) { announce(error.message, true); await refresh(); } }
async function setAgentEnabled(id, enabled) { const agent = state.settings?.agents.find((candidate) => candidate.id === id); await updateAgent(id, { enabled }, agent ? `${agent.title}${enabled ? "已启用" : "已关闭"}。` : "Agent 设置已更新。"); }
async function setAgentProvider(id, providerId) { const agent = state.settings?.agents.find((candidate) => candidate.id === id); await updateAgent(id, { providerId }, agent ? `${agent.title} 已绑定到 ${providerLabel(providerId)}。` : "Agent Provider 已更新。"); }
async function installProvider(id) { const button = document.querySelector(`[data-install-provider="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { await api(`/api/agents/${encodeURIComponent(id)}/install`, { method: "POST" }); await refresh(); announce(`${providerLabel(id)} 已安装并完成检测。`); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
async function installMissingProviders() { const button = $("install-missing-providers"); button.disabled = true; button.textContent = "正在安装…"; try { const result = await api("/api/agents/install-missing", { method: "POST" }); await refresh(); announce(result.installed.length ? `已自动安装 ${result.installed.length} 个 Provider。` : "所有 Provider 已就绪。"); } catch (error) { announce(error.message, true); await refresh(); } }
async function searchMemories(query) { try { const result = await api(`/api/memory/governed/recall?q=${encodeURIComponent(query)}`); renderMemorySearch(result.matches || []); } catch (error) { announce(error.message, true); } }
function confirmDialog(message, okLabel) { return new Promise((resolve) => { const modal = $("confirm-modal"); $("confirm-message").textContent = message; const ok = $("confirm-ok"); ok.textContent = okLabel || "确认"; modal.setAttribute("aria-hidden", "false"); const done = (result) => { modal.setAttribute("aria-hidden", "true"); ok.onclick = $("confirm-cancel").onclick = modal.onclick = null; resolve(result); }; ok.onclick = () => done(true); $("confirm-cancel").onclick = () => done(false); modal.onclick = (event) => { if (event.target === modal) done(false); }; }); }
async function deleteSession(id) { if (!(await confirmDialog("从会话列表删除这条任务？执行记录会继续保留在本机审计日志中。", "删除"))) return; try { await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }); state.scrollPositions.delete(id); state.openDisclosures.delete(id); state.disclosureScrollPositions.delete(id); if (state.selectedId === id) { state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); } await refresh({ preserveScroll: false }); announce("会话已从列表移除。"); } catch (error) { announce(error.message, true); } }
$("session-list").addEventListener("click", (event) => { const remove = event.target.closest("[data-delete-session]"); if (remove) { void deleteSession(remove.dataset.deleteSession); return; } const button = event.target.closest("[data-session]"); if (button) { setSidebarOpen(false); void selectSession(button.dataset.session); } });
$("conversation-inner").addEventListener("click", (event) => { const suggestion = event.target.closest("[data-suggestion]"); if (suggestion) { $("query").value = suggestion.dataset.suggestion; resizeComposer(); $("query").focus(); } const approval = event.target.closest("[data-approve]"); if (approval) void approve(approval.dataset.approve); const rejection = event.target.closest("[data-reject]"); if (rejection) void reject(rejection.dataset.reject); const copyButton = event.target.closest("[data-copy-code]"); if (copyButton) { const code = copyButton.parentElement?.querySelector("code"); if (code) void navigator.clipboard.writeText(code.textContent || "").then(() => { copyButton.textContent = "已复制"; setTimeout(() => { copyButton.textContent = "复制"; }, 1500); }).catch(() => announce("复制失败，请手动选中代码复制。", true)); } const expand = event.target.closest("[data-expand]"); if (expand) { const text = expand.parentElement?.querySelector(".clone-text"); if (text) { const collapsed = text.classList.toggle("collapsed"); expand.textContent = collapsed ? "展开全部" : "收起"; } } });
$("conversation-inner").addEventListener("toggle", rememberDisclosure, true);
$("conversation-inner").addEventListener("scroll", rememberDisclosureScroll, true);
$("config-workspace-save").addEventListener("click", () => void saveWorkspace());
$("connector-add").addEventListener("click", () => void addConnector());
$("connector-list").addEventListener("click", (event) => { const remove = event.target.closest("[data-connector-remove]"); if (remove) void removeConnector(remove.dataset.connectorRemove); });
$("connector-list").addEventListener("change", (event) => { const toggle = event.target.closest("[data-connector-toggle]"); if (toggle) void setConnectorEnabled(toggle.dataset.connectorToggle, toggle.checked); });
$("schedule-open").addEventListener("click", openSchedules);
$("schedule-close").addEventListener("click", closeSchedules);
$("schedule-modal").addEventListener("click", (event) => { if (event.target === $("schedule-modal")) closeSchedules(); });
function setSidebarOpen(open) { document.body.classList.toggle("sidebar-open", open); }
$("menu-open").addEventListener("click", () => setSidebarOpen(true));
$("sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
$("settings-open").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-modal").addEventListener("click", (event) => { if (event.target === $("settings-modal")) closeSettings(); });
$("settings-modal").addEventListener("click", (event) => { const button = event.target.closest("[data-settings-section]"); if (button) selectSettingsSection(button.dataset.settingsSection); });
$("schedule-form").addEventListener("submit", (event) => { event.preventDefault(); void createSchedule($("schedule-query").value.trim()); });
$("schedule-kind").addEventListener("change", renderScheduleOptions);
$("schedule-list").addEventListener("click", (event) => { const button = event.target.closest("[data-schedule-toggle]"); if (button) void setScheduleEnabled(button.dataset.scheduleToggle, button.dataset.scheduleEnabled === "true"); });
$("agent-settings-list").addEventListener("change", (event) => { const target = event.target; const toggle = target.closest("[data-agent-toggle]"); if (toggle) { void setAgentEnabled(toggle.dataset.agentToggle, toggle.checked); return; } const provider = target.closest("[data-agent-provider]"); if (provider) void setAgentProvider(provider.dataset.agentProvider, provider.value); });
$("provider-registry").addEventListener("click", (event) => { const button = event.target.closest("[data-install-provider]"); if (button) void installProvider(button.dataset.installProvider); });
$("install-missing-providers").addEventListener("click", () => void installMissingProviders());
$("audit-session-list").addEventListener("click", (event) => { const button = event.target.closest("[data-open-audit-run]"); if (button) { closeSettings(); void selectSession(button.dataset.openAuditRun); } });
$("memory-candidates").addEventListener("click", (event) => { const promote = event.target.closest("[data-promote-candidate]"); if (promote) { void decideCandidate(promote.dataset.promoteCandidate, "promote"); return; } const reject = event.target.closest("[data-reject-candidate]"); if (reject) void decideCandidate(reject.dataset.rejectCandidate, "reject"); });
$("library-list").addEventListener("click", (event) => { const save = event.target.closest("[data-save-library]"); if (save) { void saveLibraryMemory(save.dataset.saveLibrary); return; } const source = event.target.closest("[data-open-memory-source]"); if (source) { closeSettings(); void selectSession(source.dataset.openMemorySource); } });
$("library-create").addEventListener("click", () => void createLibraryMemory());
$("opportunity-strip").addEventListener("click", (event) => { const accept = event.target.closest("[data-accept-opportunity]"); if (accept) { void decideOpportunity(accept.dataset.acceptOpportunity, "accept"); return; } const dismiss = event.target.closest("[data-dismiss-opportunity]"); if (dismiss) void decideOpportunity(dismiss.dataset.dismissOpportunity, "dismiss"); });
$("context-search-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("context-search-query").value.trim(); if (query.length < 2) { announce("请输入至少两个字来搜索历史。", true); return; } void searchContextHistory(query); });
$("memory-search-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("memory-search-query").value.trim(); if (query.length < 2) { announce("请输入至少两个字来测试检索。", true); return; } void searchMemories(query); });
$("new-session").addEventListener("click", () => { setSidebarOpen(false); rememberCurrentScroll(); if (state.selectedId) state.drafts.set(state.selectedId, $("query").value); $("query").value = ""; resizeComposer(); state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); renderSessions(state.dashboard?.sessions || []); renderSession(null); $("query").focus(); });
$("request-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("query").value.trim(); if (query.length < 3) { announce("请再多描述一点你想推进的事情。", true); return; } void createSession(query); });
$("query").addEventListener("input", resizeComposer);
$("query").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("request-form").requestSubmit(); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { setSidebarOpen(false); closeSchedules(); closeSettings(); } });
function updateScrollBottom() { const viewport = $("conversation"); const far = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 160; $("scroll-bottom").classList.toggle("visible", far); }
$("conversation").addEventListener("scroll", rememberCurrentScroll, { passive: true });
$("conversation").addEventListener("scroll", updateScrollBottom, { passive: true });
$("scroll-bottom").addEventListener("click", () => { const viewport = $("conversation"); viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }); });
$("sidebar-resizer").addEventListener("pointerdown", (event) => { sidebarResizeActive = true; document.body.classList.add("sidebar-resizing"); event.currentTarget.setPointerCapture(event.pointerId); applySidebarWidth(event.clientX); });
$("sidebar-resizer").addEventListener("pointermove", (event) => { if (sidebarResizeActive) applySidebarWidth(event.clientX); });
$("sidebar-resizer").addEventListener("pointerup", (event) => { sidebarResizeActive = false; document.body.classList.remove("sidebar-resizing"); event.currentTarget.releasePointerCapture(event.pointerId); });
$("sidebar-resizer").addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const current = Number($("sidebar-resizer").getAttribute("aria-valuenow")); applySidebarWidth(current + (event.key === "ArrowRight" ? 16 : -16)); });
window.addEventListener("resize", () => applySidebarWidth(Number($("sidebar-resizer").getAttribute("aria-valuenow")), false));
restoreSidebarWidth();
if (location.protocol === "http:" || location.protocol === "https:") { void refresh({ preserveScroll: false }); state.refreshTimer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000); }
