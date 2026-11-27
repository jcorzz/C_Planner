import { createFlowchart } from "./flowchart.js";
import changelog from "./changelog.json";

const APP_VERSION = __APP_VERSION__;

const STORAGE_KEY = "planner.team.activities.v1";
const HOLIDAY_KEY = "planner.team.holidays.v1";
const PROJECTS_KEY = "planner.team.projects.v1";
const PEOPLE_KEY = "planner.team.people.v1";
const DELIVERABLES_KEY = "planner.team.deliverables.v1";
const TEAMS_KEY = "planner.team.teams.v1";
const GRAPH_EDGES_KEY = "planner.team.graph-edges.v1";
const GRAPH_POSITIONS_KEY = "planner.team.graph-positions.v1";
const BACKLOG_PHASE = "Backlog";
const statuses = ["Não iniciada", "Em andamento", "Bloqueada", "Concluída", "Cancelada"];
const priorities = ["Baixa", "Normal", "Alta", "Crítica"];
let tasks = loadJson(STORAGE_KEY, []);
let holidays = loadJson(HOLIDAY_KEY, []);
let projects = loadJson(PROJECTS_KEY, []);
let people = loadJson(PEOPLE_KEY, []);
let deliverables = loadJson(DELIVERABLES_KEY, []);
let teams = loadJson(TEAMS_KEY, []);
let graphEdges = loadJson(GRAPH_EDGES_KEY, []);
let graphPositions = loadStoredValue(GRAPH_POSITIONS_KEY, {});
let currentView = "team";
let groupByMode = "none";
let projectListFilter = "Ativo";
let flowchart;
let selectedFlowProjectId = "";
let pendingFlowCreation = null;
const deliverablesToPosition = new Set();
let toastTimer;

const elements = {
  rows: document.querySelector("#task-rows"),
  empty: document.querySelector("#empty-state"),
  dialog: document.querySelector("#task-dialog"),
  form: document.querySelector("#task-form"),
  metrics: document.querySelector("#metrics"),
  toast: document.querySelector("#toast"),
};

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function loadStoredValue(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function saveAll() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  localStorage.setItem(HOLIDAY_KEY, JSON.stringify(holidays));
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
  localStorage.setItem(DELIVERABLES_KEY, JSON.stringify(deliverables));
  localStorage.setItem(TEAMS_KEY, JSON.stringify(teams));
  localStorage.setItem(GRAPH_EDGES_KEY, JSON.stringify(graphEdges));
  localStorage.setItem(GRAPH_POSITIONS_KEY, JSON.stringify(graphPositions));
}

function deriveProjectsFromTasks(sourceTasks = tasks) {
  return [...new Set(sourceTasks.map((task) => task.project).filter(Boolean))]
    .map((name) => ({ id: crypto.randomUUID(), name, status: "Ativo", description: "" }));
}

function derivePeopleFromTasks(sourceTasks = tasks) {
  return [...new Set(sourceTasks.flatMap((task) => task.people || []).filter(Boolean))]
    .map((name) => ({ id: crypto.randomUUID(), name, capacityHoursPerDay: 8 }));
}

function migrateRegistries() {
  const needsProjectMigration = localStorage.getItem(PROJECTS_KEY) === null;
  const needsPeopleMigration = localStorage.getItem(PEOPLE_KEY) === null;
  if (needsProjectMigration) projects = deriveProjectsFromTasks();
  if (needsPeopleMigration) people = derivePeopleFromTasks();
  if (needsProjectMigration || needsPeopleMigration) saveAll();
}

migrateRegistries();

function migrateDeliverables() {
  let changed = false;
  for (const task of tasks) {
    const project = projects.find((item) => item.name === task.project);
    if (!project) continue;
    const legacyNames = task.deliverables || []; // Legacy names from the task
    const linkedIds = [];
    for (const name of legacyNames) {
      let deliverable = deliverables.find((item) => item.projectId === project.id && item.name === name);
      if (!deliverable) {
        deliverable = { id: crypto.randomUUID(), projectId: project.id, name };
        deliverables.push(deliverable);
        changed = true;
      }
      linkedIds.push(deliverable.id);
    }
    if (!task.deliverableId && linkedIds.length) {
      task.deliverableId = linkedIds[0];
      if (linkedIds.length > 1) task.sharedDeliverableIds = [...new Set([...(task.sharedDeliverableIds || []), ...linkedIds.slice(1)])];
      changed = true;
    }
  }
  if (changed) saveAll();
}

migrateDeliverables();

function migrateProjectPhases() {
  let changed = false;
  projects = projects.map((project) => {
    const projectDeliverables = deliverables.filter((deliverable) => deliverable.projectId === project.id);
    const savedPhases = Array.isArray(project.phases) ? project.phases.filter((phase) => phase && phase !== BACKLOG_PHASE) : [];
    const deliverablePhases = projectDeliverables.map((item) => item.phase).filter((phase) => phase && phase !== BACKLOG_PHASE);
    const phases = [...new Set([...savedPhases, ...deliverablePhases]), BACKLOG_PHASE];
    if (JSON.stringify(project.phases || []) !== JSON.stringify(phases)) changed = true;
    return { ...project, phases };
  });
  deliverables = deliverables.map((item) => {
    const project = projects.find((entry) => entry.id === item.projectId);
    const phase = project?.phases.includes(item.phase) ? item.phase : BACKLOG_PHASE;
    if (item.phase !== phase) changed = true;
    return { ...item, phase };
  });
  if (changed) saveAll();
}

migrateProjectPhases();

function migrateTaskExecution() {
  let changed = false;
  tasks = tasks.map((task) => {
    const executionType = task.executionType === "external" ? "external" : "internal";
    const teamIds = Array.isArray(task.teamIds) ? [...new Set(task.teamIds.filter((id) => teams.some((team) => team.id === id)))] : [];
    if (task.executionType !== executionType || JSON.stringify(task.teamIds || []) !== JSON.stringify(teamIds)) changed = true;
    return { ...task, executionType, teamIds };
  });
  if (localStorage.getItem(TEAMS_KEY) === null) changed = true;
  if (changed) saveAll();
}

migrateTaskExecution();

function getTaskDeliverableIds(task) {
  return [...new Set([task.deliverableId, ...(task.sharedDeliverableIds || [])].filter(Boolean))];
}

const CLOSED_TASK_STATUSES = ["Concluída", "Cancelada"];

function formatCompletionDate(value) {
  return value ? value.split("-").reverse().join("/") : "";
}

function isDeliverableCompleted(deliverable) {
  if (!deliverable) return false;
  if (deliverable.completedAt) return true;
  const project = projects.find((item) => item.id === deliverable.projectId);
  return Boolean(project?.completedPhases?.[deliverable.phase]);
}

function countOpenTasks(deliverableIds) {
  const ids = new Set(deliverableIds);
  return tasks.filter((task) => !CLOSED_TASK_STATUSES.includes(task.status) && getTaskDeliverableIds(task).some((id) => ids.has(id))).length;
}

function openTasksMessage(count, subject) {
  return `Não é possível concluir ${subject}: ${count} ${count === 1 ? "atividade ainda não foi concluída ou cancelada" : "atividades ainda não foram concluídas ou canceladas"}.`;
}

function logProjectHistory(projectId, entries) {
  const at = new Date().toISOString();
  projects = projects.map((item) => item.id === projectId ? { ...item, history: [...(item.history || []), ...entries.map((entry) => ({ at, ...entry }))] } : item);
}

function renderProjectHistory() {
  const list = document.querySelector("#project-history-list");
  const history = [...(currentDialogProject()?.history || [])].reverse();
  document.querySelector("#project-history-empty").classList.toggle("hidden", history.length > 0);
  list.innerHTML = history.map((entry) => {
    const done = entry.action === "Concluído" || entry.action === "Concluída";
    return `<li class="history-row"><time>${escapeHtml(new Date(entry.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }))}</time><span class="history-kind">${escapeHtml(entry.kind)}</span><strong>${escapeHtml(entry.name)}</strong><span class="history-action ${done ? "done" : "reopened"}">${escapeHtml(entry.action)}</span>${entry.note ? `<small>${escapeHtml(entry.note)}</small>` : ""}</li>`;
  }).join("");
}

function toggleDeliverableCompletion(id) {
  const deliverable = deliverables.find((item) => item.id === id);
  if (!deliverable) return;
  const project = projects.find((item) => item.id === deliverable.projectId);
  if (deliverable.completedAt) {
    if (project?.completedPhases?.[deliverable.phase]) return showToast(`Reabra a fase “${deliverable.phase}” antes de reabrir este entregável.`);
    deliverables = deliverables.map((item) => {
      if (item.id !== id) return item;
      const { completedAt, ...reopened } = item;
      return reopened;
    });
  } else {
    const open = countOpenTasks([id]);
    if (open) return showToast(openTasksMessage(open, "o entregável"));
    deliverables = deliverables.map((item) => item.id === id ? { ...item, completedAt: localDateValue() } : item);
  }
  logProjectHistory(deliverable.projectId, [{ kind: "Entregável", name: deliverable.name, action: deliverable.completedAt ? "Reaberto" : "Concluído" }]);
  saveAll();
  renderFlowchart();
  showToast(deliverable.completedAt ? "Entregável reaberto." : "Entregável concluído.");
}

function buildProjectReportHtml(project) {
  const projectDeliverables = deliverables.filter((item) => item.projectId === project.id);
  const phases = project.phases || [BACKLOG_PHASE];
  const fmtDate = (value) => value ? formatCompletionDate(value) : "—";
  const field = (label, value) => `<tr><th>${label}</th><td>${escapeHtml(value || "—")}</td></tr>`;
  const phaseRows = phases.map((phase, index) => {
    const date = project.completedPhases?.[phase];
    const count = projectDeliverables.filter((item) => item.phase === phase).length;
    return `<tr><td>${index + 1}</td><td>${escapeHtml(phase)}</td><td>${count}</td><td>${date ? `Concluída em ${fmtDate(date)}` : phase === BACKLOG_PHASE ? "—" : "Em andamento"}</td></tr>`;
  }).join("");
  const deliverableRows = projectDeliverables.map((item) => {
    const done = isDeliverableCompleted(item);
    return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.phase)}</td><td>${done ? `Concluído em ${fmtDate(item.completedAt || project.completedPhases?.[item.phase])}` : "Em andamento"}</td></tr>`;
  }).join("") || '<tr><td colspan="3">Nenhum entregável cadastrado.</td></tr>';
  const historyRows = [...(project.history || [])].reverse().map((entry) => `<tr><td>${escapeHtml(new Date(entry.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }))}</td><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(entry.action)}${entry.note ? ` <small>(${escapeHtml(entry.note)})</small>` : ""}</td></tr>`).join("") || '<tr><td colspan="4">Nenhum registro.</td></tr>';
  const activeTasks = tasks.filter((task) => (task.project === project.name || (task.projectLinks || []).includes(project.id)) && task.status === "Em andamento");
  const taskRows = activeTasks.map((task) => `<tr><td>${escapeHtml(task.name)}</td><td>${escapeHtml((task.people || []).join(", ") || "—")}</td><td>${fmtDate(task.actualStart)}</td><td>${fmtDate(task.end)}</td></tr>`).join("") || '<tr><td colspan="4">Nenhuma atividade em andamento.</td></tr>';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(project.name)}</title><style>
    body{font-family:Segoe UI,Arial,sans-serif;color:#23342f;margin:0;font-size:12px}
    h1{font-size:22px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #17677a;color:#17677a}
    .meta{color:#6e8175;margin-bottom:8px}table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #d8e2dc;padding:6px 8px;text-align:left;vertical-align:top}
    thead th{background:#eef4f1}.info th{width:28%;background:#f5f8f5}.desc{white-space:pre-wrap}
    tr{page-break-inside:avoid}</style></head><body>
    <h1>${escapeHtml(project.name)}</h1><div class="meta">Relatório gerado em ${escapeHtml(new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }))}</div>
    <h2>Informações do projeto</h2><table class="info">${field("Situação", project.status)}${field("Solicitante", project.requester)}${field("Solicitado via", project.requestedVia)}${field("Data da solicitação", project.requestDate ? fmtDate(project.requestDate) : "")}<tr><th>Descrição</th><td class="desc">${escapeHtml(project.description || "—")}</td></tr></table>
    <h2>Fases</h2><table><thead><tr><th>#</th><th>Fase</th><th>Entregáveis</th><th>Situação</th></tr></thead><tbody>${phaseRows}</tbody></table>
    <h2>Entregáveis</h2><table><thead><tr><th>Entregável</th><th>Fase</th><th>Situação</th></tr></thead><tbody>${deliverableRows}</tbody></table>
    <h2>Atividades em andamento</h2><table><thead><tr><th>Atividade</th><th>Responsável</th><th>Início real</th><th>Término previsto</th></tr></thead><tbody>${taskRows}</tbody></table>
    <h2>Histórico</h2><table><thead><tr><th>Data/hora</th><th>Tipo</th><th>Item</th><th>Ação</th></tr></thead><tbody>${historyRows}</tbody></table>
    </body></html>`;
}

async function exportProjectPdf(projectId) {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return showToast("Salve o projeto antes de exportar.");
  const html = buildProjectReportHtml(project);
  const safeName = project.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "projeto";
  if (window.cPlanner?.exportPdf) {
    try {
      const result = await window.cPlanner.exportPdf({ html, defaultName: `${safeName}.pdf` });
      if (!result.canceled) showToast("PDF exportado.");
    } catch {
      showToast("Não foi possível exportar o PDF.");
    }
    return;
  }
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 2000);
  };
  document.body.append(frame);
  showToast("Na janela de impressão, escolha “Salvar como PDF”.");
}

function togglePhaseCompletion(projectId, phase) {
  const project = projects.find((item) => item.id === projectId);
  if (!project || !phase || phase === BACKLOG_PHASE) return;
  const completedPhases = { ...(project.completedPhases || {}) };
  const phaseDeliverableIds = deliverables.filter((item) => item.projectId === projectId && item.phase === phase).map((item) => item.id);
  const reopening = Boolean(completedPhases[phase]);
  const cascadeNote = `Junto com a fase “${phase}”`;
  const cascadeEntries = [];
  if (reopening) {
    deliverables.filter((item) => phaseDeliverableIds.includes(item.id) && item.completedAt).forEach((item) => cascadeEntries.push({ kind: "Entregável", name: item.name, action: "Reaberto", note: cascadeNote }));
    delete completedPhases[phase];
    deliverables = deliverables.map((item) => {
      if (!phaseDeliverableIds.includes(item.id)) return item;
      const { completedAt, ...reopened } = item;
      return reopened;
    });
  } else {
    const open = countOpenTasks(phaseDeliverableIds);
    if (open) return showToast(openTasksMessage(open, "a fase"));
    const today = localDateValue();
    completedPhases[phase] = today;
    deliverables.filter((item) => phaseDeliverableIds.includes(item.id) && !item.completedAt).forEach((item) => cascadeEntries.push({ kind: "Entregável", name: item.name, action: "Concluído", note: cascadeNote }));
    deliverables = deliverables.map((item) => phaseDeliverableIds.includes(item.id) ? { ...item, completedAt: item.completedAt || today } : item);
  }
  projects = projects.map((item) => item.id === projectId ? { ...item, completedPhases } : item);
  logProjectHistory(projectId, [{ kind: "Fase", name: phase, action: reopening ? "Reaberta" : "Concluída" }, ...cascadeEntries]);
  saveAll();
  renderFlowchart();
  updateProjectCompletionUi();
  showToast(reopening ? "Fase reaberta, junto com seus entregáveis." : "Fase concluída, junto com seus entregáveis.");
}

function taskDeliverableNames(task) {
  const linkedNames = getTaskDeliverableIds(task)
    .map((id) => deliverables.find((item) => item.id === id)?.name)
    .filter(Boolean);
  return linkedNames.length ? linkedNames : (task.deliverables || []);
}

function getTaskTeamNames(task) {
  if (task.executionType !== "external") return ["Meu time"];
  return (task.teamIds || []).map((id) => teams.find((team) => team.id === id)?.name).filter(Boolean);
}

function getTaskPhaseEntries(task) {
  const entries = getTaskDeliverableIds(task).map((id) => {
    const deliverable = deliverables.find((item) => item.id === id);
    const project = projects.find((item) => item.id === deliverable?.projectId);
    return deliverable && project ? { projectId: project.id, projectName: project.name, phase: deliverable.phase || BACKLOG_PHASE, deliverableId: id } : null;
  }).filter(Boolean);
  if (entries.length) return entries;
  const project = projects.find((item) => item.name === task.project);
  return project ? [{ projectId: project.id, projectName: project.name, phase: BACKLOG_PHASE, deliverableId: "" }] : [];
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function dateLabel(value) {
  if (!value) return "Sem data";
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date).replace(" de ", "/").replace(".", "");
}

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateDistance(value) {
  if (!value) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${value}T00:00:00`);
  return Math.round((target - today) / 86400000);
}

function statusClass(status) {
  return ({ "Não iniciada": "status-not-started", "Em andamento": "status-in-progress", Bloqueada: "status-blocked", Concluída: "status-completed", Cancelada: "status-cancelled" })[status] || "status-not-started";
}

function priorityClass(priority) {
  return ({ Baixa: "priority-low", Alta: "priority-high", Crítica: "priority-critical" })[priority] || "";
}

function filteredTasks() {
  const query = document.querySelector("#search-input").value.trim().toLocaleLowerCase("pt-BR");
  const project = document.querySelector("#project-filter").value;
  const phase = document.querySelector("#phase-filter").value;
  const person = document.querySelector("#person-filter").value;
  const team = document.querySelector("#team-filter").value;
  const status = document.querySelector("#status-filter").value;
  const until = document.querySelector("#date-filter").value;
  const activeProjectIds = new Set(projects.filter((item) => item.status !== "Encerrado").map((item) => item.id));
  const selectedProject = projects.find((item) => item.name === project);
  return tasks.filter((task) => {
    const teamNames = getTaskTeamNames(task);
    const phaseNames = getTaskPhaseEntries(task).map((entry) => entry.phase);
    const text = `${task.name} ${task.project} ${taskDeliverableNames(task).join(" ")} ${phaseNames.join(" ")} ${(task.people || []).join(" ")} ${teamNames.join(" ")}`.toLocaleLowerCase("pt-BR");
    const linkedProjectIds = task.projectLinks || [];
    const taskProject = projects.find((item) => item.name === task.project);
    if ((!taskProject || !activeProjectIds.has(taskProject.id)) && !linkedProjectIds.some((id) => activeProjectIds.has(id))) return false;
    if (query && !text.includes(query)) return false;
    if (project && task.project !== project && !(selectedProject && linkedProjectIds.includes(selectedProject.id))) return false;
    if (phase && !getTaskPhaseEntries(task).some((entry) => entry.projectId === selectedProject?.id && entry.phase === phase)) return false;
    if (person && !(task.people || []).includes(person)) return false;
    if (team === "internal" && task.executionType === "external") return false;
    if (team && team !== "internal" && !(task.teamIds || []).includes(team)) return false;
    if (status && task.status !== status) return false;
    if (until && task.end && task.end > until) return false;
    return true;
  }).sort((a, b) => (a.end || "9999").localeCompare(b.end || "9999"));
}

function riskFor(task) {
  if (["Concluída", "Cancelada"].includes(task.status)) return "ok";
  const distance = dateDistance(task.end);
  if (distance !== null && distance < 0) return "late";
  if (distance !== null && distance <= 1) return "soon";
  return "ok";
}

function renderMetrics() {
  const active = tasks.filter((task) => !["Concluída", "Cancelada"].includes(task.status));
  const projectCount = projects.filter((project) => project.status !== "Encerrado").length;
  const inProgress = active.filter((task) => task.status === "Em andamento").length;
  const atRisk = active.filter((task) => riskFor(task) !== "ok").length;
  const completed = tasks.filter((task) => task.status === "Concluída").length;
  const items = [
    ["▦", projectCount, "Projetos com atividades", ""],
    ["↗", inProgress, "Atividades em andamento", ""],
    ["◷", atRisk, "Prazos que exigem atenção", atRisk ? "amber" : ""],
    ["✓", completed, "Atividades concluídas", ""],
  ];
  elements.metrics.innerHTML = items.map(([icon, value, label, tone]) => `<div class="metric"><div class="metric-mark ${tone}">${icon}</div><div><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div></div>`).join("");
  const dueTomorrow = active.filter((task) => dateDistance(task.end) === 1).length;
  document.querySelector("#notification-count").textContent = String(dueTomorrow);
}

function updateFilterOptions() {
  const projectSelect = document.querySelector("#project-filter");
  const personSelect = document.querySelector("#person-filter");
  const teamSelect = document.querySelector("#team-filter");
  const phaseSelect = document.querySelector("#phase-filter");
  const currentProject = projectSelect.value;
  const currentPerson = personSelect.value;
  const currentTeam = teamSelect.value;
  const currentPhase = phaseSelect.value;
  const activeProjectNames = projects.filter((project) => project.status !== "Encerrado").map((project) => project.name).sort();
  const personNames = people.map((person) => person.name).sort();
  const teamOptions = [{ value: "internal", label: "Meu time" }, ...teams.map((team) => ({ value: team.id, label: team.name })).sort((first, second) => first.label.localeCompare(second.label, "pt-BR"))];
  const selectedProject = projects.find((project) => project.name === currentProject);
  const projectPhases = selectedProject?.phases || [];
  projectSelect.innerHTML = `<option value="">Todos</option>${activeProjectNames.map((name) => `<option>${escapeHtml(name)}</option>`).join("")}`;
  personSelect.innerHTML = `<option value="">Todos</option>${personNames.map((name) => `<option>${escapeHtml(name)}</option>`).join("")}`;
  teamSelect.innerHTML = `<option value="">Todos os times</option>${teamOptions.map((team) => `<option value="${escapeHtml(team.value)}">${escapeHtml(team.label)}</option>`).join("")}`;
  phaseSelect.innerHTML = `<option value="">Todas as fases</option>${projectPhases.map((phase) => `<option value="${escapeHtml(phase)}">${escapeHtml(phase)}</option>`).join("")}`;
  phaseSelect.disabled = !selectedProject;
  projectSelect.value = activeProjectNames.includes(currentProject) ? currentProject : "";
  personSelect.value = personNames.includes(currentPerson) ? currentPerson : "";
  teamSelect.value = teamOptions.some((team) => team.value === currentTeam) ? currentTeam : "";
  phaseSelect.value = projectPhases.includes(currentPhase) ? currentPhase : "";
}

function renderTable() {
  updateFilterOptions();
  const filtered = filteredTasks();
  elements.rows.innerHTML = "";
  elements.empty.classList.toggle("visible", filtered.length === 0);
  document.querySelector(".table-scroll table").classList.toggle("hidden", filtered.length === 0);
  document.querySelector("#row-count").textContent = `${filtered.length} ${filtered.length === 1 ? "atividade" : "atividades"}`;
  document.querySelector("#footer-summary").textContent = `Mostrando ${filtered.length} de ${tasks.length} atividades`;
  if (filtered.length === 0) return;

  const groups = groupByMode === "person"
    ? filtered.flatMap((task) => {
      const isExternal = task.executionType === "external";
      const labels = isExternal ? (getTaskTeamNames(task).length ? getTaskTeamNames(task) : ["Time externo sem atribuição"]) : (task.people?.length ? task.people : ["Sem responsável"]);
      return labels.map((label) => ({ task, label, groupType: isExternal ? "team" : "person" }));
    })
    : groupByMode === "phase"
      ? filtered.flatMap((task) => {
        const selectedProject = projects.find((project) => project.name === document.querySelector("#project-filter").value);
        const entries = getTaskPhaseEntries(task).filter((entry) => !selectedProject || entry.projectId === selectedProject.id);
        const uniqueEntries = [...new Map(entries.map((entry) => [`${entry.projectId}:${entry.phase}`, entry])).values()];
        return (uniqueEntries.length ? uniqueEntries : [{ projectId: "", projectName: task.project, phase: "Sem fase" }])
          .map((entry) => {
            const phaseProject = projects.find((project) => project.id === entry.projectId);
            return {
              task,
              label: `${entry.projectName} · ${entry.phase}`,
              groupType: "phase",
              projectOrder: Math.max(0, projects.findIndex((project) => project.id === entry.projectId)),
              phaseOrder: Math.max(0, (phaseProject?.phases || []).indexOf(entry.phase)),
            };
          });
      })
      : filtered.map((task) => ({ task, label: null, groupType: null }));
  if (groupByMode === "phase") groups.sort((first, second) => first.projectOrder - second.projectOrder || first.phaseOrder - second.phaseOrder || (first.task.end || "9999").localeCompare(second.task.end || "9999"));
  let lastGroup = "";
  for (const { task, label, groupType } of groups) {
    const groupKey = `${groupType}:${label}`;
    if (groupByMode !== "none" && groupKey !== lastGroup) {
      const groupRow = document.createElement("tr");
      groupRow.className = "group-heading-row";
      const groupCount = groups.filter((item) => item.groupType === groupType && item.label === label).length;
      groupRow.innerHTML = `<td colspan="10"><span class="group-heading-avatar">${escapeHtml(groupType === "team" ? initials(label) || "T" : initials(label) || "?")}</span><strong>${groupType === "team" ? `Time: ${escapeHtml(label)}` : groupType === "phase" ? `Fase: ${escapeHtml(label)}` : escapeHtml(label)}</strong><span>${groupCount} ${groupCount === 1 ? "atividade" : "atividades"}</span></td>`;
      elements.rows.append(groupRow);
      lastGroup = groupKey;
    }
    const deliverableLabels = taskDeliverableNames(task).map(escapeHtml).join(", ");
    const linkedProjects = (task.projectLinks || []).map((id) => projects.find((project) => project.id === id)?.name).filter(Boolean);
    const projectLabel = [task.project, ...linkedProjects].join(", ");
    const people = groupByMode === "person" && groupType === "person" ? [label] : task.executionType === "external" ? [] : task.people || [];
    const taskTeams = getTaskTeamNames(task);
    const taskPhases = [...new Set(getTaskPhaseEntries(task).map((entry) => entry.phase))];
    const risk = riskFor(task);
    const riskLabel = risk === "late" ? "Atrasada" : risk === "soon" ? "Vence amanhã" : "";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="task-name-cell"><span class="task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</span><span class="task-description">${escapeHtml(task.description || "Sem descrição")}</span></td>
      <td><span class="project-name" title="${escapeHtml(projectLabel)}">${escapeHtml(projectLabel)}</span><span class="deliverable-name">${deliverableLabels || "Sem entregável"}${getTaskDeliverableIds(task).length > 1 || (task.projectLinks || []).length ? '<span class="shared-label">Compartilhado</span>' : ""}</span></td>
      <td><div class="phase-chip-list">${taskPhases.map((phase) => `<span class="phase-chip" title="${escapeHtml(phase)}">${escapeHtml(phase)}</span>`).join("") || "—"}</div></td>
      <td><div class="team-chip-list">${taskTeams.map((name) => `<span class="team-chip" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join("") || "—"}</div></td>
      <td><div class="assignee-list">${people.map((name) => `<span class="assignee-chip"><span class="assignee-avatar">${escapeHtml(initials(name))}</span>${escapeHtml(name)}</span>`).join("")}</div></td>
      <td><span class="date-range"><i class="risk-indicator risk-${risk}"></i>${dateLabel(task.start)} — ${dateLabel(task.end)}${riskLabel ? `<span>${riskLabel}</span>` : ""}</span></td>
      <td><span class="status-pill ${statusClass(task.status)}">${escapeHtml(task.status)}</span></td>
      <td><span class="priority-pill ${priorityClass(task.priority)}">${escapeHtml(task.priority)}</span></td>
      <td><span class="effort-value">${task.effort ? escapeHtml(task.effort) : "—"}</span> <span class="effort-unit">${task.effort ? "h" : ""}</span></td>
      <td><div class="row-action-group"><button class="row-actions" data-edit="${escapeHtml(task.id)}" title="Editar atividade" aria-label="Editar atividade">···</button><button class="row-actions delete-action" data-delete="${escapeHtml(task.id)}" title="Excluir atividade" aria-label="Excluir atividade">×</button></div></td>`;
    elements.rows.append(row);
  }
  elements.rows.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => openTaskDialog(button.dataset.edit)));
  elements.rows.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => deleteTask(button.dataset.delete)));
}

function deleteTask(taskId) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  const shared = (task.projectLinks || []).length || (task.sharedDeliverableIds || []).length;
  const scope = shared ? "Ela está compartilhada entre planos." : ""; 
  if (!confirm(`Excluir a atividade “${task.name}”? ${scope} Esta ação não pode ser desfeita.`)) return;
  tasks = tasks.filter((item) => item.id !== taskId);
  graphEdges = graphEdges.filter((edge) => edge.source !== `task:${taskId}` && edge.target !== `task:${taskId}`);
  for (const positionId of Object.keys(graphPositions)) {
    if (positionId === `task:${taskId}` || positionId.startsWith(`task:${taskId}:phase:`) || positionId.startsWith(`task:${taskId}:path:`)) delete graphPositions[positionId];
  }
  saveAll();
  renderMetrics();
  renderTable();
  if (currentView === "flowchart") renderFlowchart();
  showToast("Atividade excluída.");
}

function deleteProject(projectId) {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  const projectDeliverableIds = new Set(deliverables.filter((item) => item.projectId === projectId).map((item) => item.id));
  const associatedTasks = tasks.filter((task) => task.project === project.name || (task.projectLinks || []).includes(projectId));
  const tasksToDelete = associatedTasks.filter((task) => task.project === project.name
    && !(task.projectLinks || []).some((id) => id !== projectId && projects.some((item) => item.id === id)));
  const taskIdsToTransfer = new Set(associatedTasks.filter((task) => !tasksToDelete.includes(task)).map((task) => task.id));
  const tasksToTransfer = associatedTasks.length - tasksToDelete.length;
  const confirmed = confirm(`Excluir o projeto “${project.name}”? ${projectDeliverableIds.size} entregáveis serão removidos; ${tasksToDelete.length} atividades exclusivas serão excluídas${tasksToTransfer ? ` e ${tasksToTransfer} atividades compartilhadas serão mantidas nos projetos restantes` : ""}. Esta ação não pode ser desfeita.`);
  if (!confirmed) return;

  const deletedTaskIds = new Set(tasksToDelete.map((task) => task.id));
  tasks = tasks.filter((task) => !deletedTaskIds.has(task.id)).map((task) => {
    const remainingProjectLinks = [...new Set((task.projectLinks || []).filter((id) => id !== projectId && projects.some((item) => item.id === id)))];
    const remainingDeliverableIds = getTaskDeliverableIds(task).filter((id) => !projectDeliverableIds.has(id));
    let primaryProject = task.project;
    let nextProjectLinks = remainingProjectLinks;
    if (task.project === project.name && remainingProjectLinks.length) {
      const newPrimary = projects.find((item) => item.id === remainingProjectLinks[0]);
      if (newPrimary) {
        primaryProject = newPrimary.name;
        nextProjectLinks = remainingProjectLinks.filter((id) => id !== newPrimary.id);
      }
    }
    return {
      ...task,
      project: primaryProject,
      projectLinks: nextProjectLinks,
      deliverableId: remainingDeliverableIds[0] || "",
      sharedDeliverableIds: remainingDeliverableIds.slice(1),
    };
  });

  deliverables = deliverables.filter((item) => item.projectId !== projectId);
  projects = projects.filter((item) => item.id !== projectId);
  graphEdges = graphEdges.filter((edge) => {
    const removedNode = (nodeId) => nodeId === `project:${projectId}`
      || (nodeId.startsWith("deliverable:") && projectDeliverableIds.has(nodeId.slice("deliverable:".length)))
      || (nodeId.startsWith("task:") && deletedTaskIds.has(nodeId.slice("task:".length).split(":path:")[0].split(":phase:")[0]));
    return !removedNode(edge.source) && !removedNode(edge.target);
  });
  for (const positionId of Object.keys(graphPositions)) {
    if (positionId === `project:${projectId}`
      || (positionId.startsWith("deliverable:") && projectDeliverableIds.has(positionId.slice("deliverable:".length)))
      || (positionId.startsWith("task:") && (deletedTaskIds.has(positionId.slice("task:".length).split(":path:")[0].split(":phase:")[0])
        || taskIdsToTransfer.has(positionId.slice("task:".length).split(":path:")[0].split(":phase:")[0])))) delete graphPositions[positionId];
  }
  if (selectedFlowProjectId === projectId) selectedFlowProjectId = "";
  saveAll();
  renderMetrics();
  renderTable();
  if (currentView === "flowchart") renderFlowchart();
  else renderSecondary("projects");
  showToast(`Projeto excluído. ${tasksToTransfer ? `${tasksToTransfer} atividades compartilhadas foram mantidas.` : ""}`);
}

function deleteDeliverable(deliverableId) {
  const deliverable = deliverables.find((item) => item.id === deliverableId);
  if (!deliverable) return;
  if (!confirm(`Remover “${deliverable.name}” do fluxograma? O entregável continuará cadastrado no projeto.`)) return;
  deliverables = deliverables.map((item) => item.id === deliverableId ? { ...item, hiddenFromFlowchart: true } : item);
  saveAll();
  renderFlowchart();
  showToast("Entregável removido do fluxograma; cadastro do projeto preservado.");
}

function renderSecondary(view) {
  const target = document.querySelector(`#${view}-view`);
  if (view === "projects") {
    const filteredProjects = projects.filter((project) => projectListFilter === "Todos" || project.status === projectListFilter);
    const sortedProjects = [...filteredProjects].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    target.innerHTML = `<div class="secondary-heading"><div><div class="eyebrow"><span class="eyebrow-rule"></span> PORTFÓLIO</div><h1>Projetos</h1></div><div class="secondary-heading-actions"><select class="project-status-filter" id="project-list-filter" aria-label="Filtrar situação dos projetos"><option ${projectListFilter === "Ativo" ? "selected" : ""}>Ativo</option><option ${projectListFilter === "Encerrado" ? "selected" : ""}>Encerrado</option><option ${projectListFilter === "Todos" ? "selected" : ""}>Todos</option></select><button class="button button-primary" id="new-project-button"><span class="button-symbol">＋</span> Novo projeto</button></div></div><p class="section-description">${projects.filter((project) => project.status !== "Encerrado").length} projetos ativos · ${projects.filter((project) => project.status === "Encerrado").length} encerrados</p><div class="secondary-list">${sortedProjects.length ? sortedProjects.map((project) => { const projectTasks = tasks.filter((task) => task.project === project.name || (task.projectLinks || []).includes(project.id)); const deliverableCount = deliverables.filter((deliverable) => deliverable.projectId === project.id).length; return `<div class="secondary-row"><div><strong>${escapeHtml(project.name)}</strong><small>${projectTasks.length} atividades · ${deliverableCount} entregáveis${project.requester ? ` · Solicitante: ${escapeHtml(project.requester)}` : ""}${project.description ? ` · ${escapeHtml(project.description)}` : ""}</small></div><div class="secondary-row-actions"><button class="button button-secondary action-button" data-open-flow="${escapeHtml(project.id)}">Fluxograma</button><span class="status-pill ${project.status === "Encerrado" ? "status-cancelled" : "status-in-progress"}">${escapeHtml(project.status)}</span><button class="button button-secondary action-button" data-export-project="${escapeHtml(project.id)}">PDF</button><button class="button button-secondary action-button" data-edit-project="${escapeHtml(project.id)}">Editar</button><button class="button button-secondary action-button delete-project-button" data-delete-project="${escapeHtml(project.id)}">Excluir</button></div></div>`; }).join("") : `<div class="secondary-empty">Nenhum projeto ${projectListFilter === "Todos" ? "cadastrado" : projectListFilter.toLocaleLowerCase("pt-BR")}.</div>`}</div>`;
    target.querySelector("#project-list-filter").addEventListener("change", (event) => {
      projectListFilter = event.target.value;
      renderSecondary("projects");
    });
    target.querySelector("#new-project-button").addEventListener("click", () => openProjectDialog());
    target.querySelectorAll("[data-open-flow]").forEach((button) => button.addEventListener("click", () => {
      selectedFlowProjectId = button.dataset.openFlow;
      setView("flowchart");
    }));
    target.querySelectorAll("[data-edit-project]").forEach((button) => button.addEventListener("click", () => openProjectDialog(button.dataset.editProject)));
    target.querySelectorAll("[data-export-project]").forEach((button) => button.addEventListener("click", () => exportProjectPdf(button.dataset.exportProject)));
    target.querySelectorAll("[data-delete-project]").forEach((button) => button.addEventListener("click", () => deleteProject(button.dataset.deleteProject)));
  } else if (view === "people") {
    const sortedPeople = [...people].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    target.innerHTML = `<div class="secondary-heading"><div><div class="eyebrow"><span class="eyebrow-rule"></span> RECURSOS</div><h1>Pessoas</h1></div><button class="button button-primary" id="new-person-button"><span class="button-symbol">＋</span> Nova pessoa</button></div><p class="section-description">${people.length} pessoas cadastradas no time.</p><div class="secondary-list">${sortedPeople.length ? sortedPeople.map((person) => { const assigned = tasks.filter((task) => (task.people || []).includes(person.name) && !["Concluída", "Cancelada"].includes(task.status)); return `<div class="secondary-row"><div><strong>${escapeHtml(person.name)}</strong><small>${assigned.length} atividades ativas · ${new Set(assigned.map((task) => task.project)).size} projetos · ${escapeHtml(person.capacityHoursPerDay || 8)} h/dia</small></div><div class="secondary-row-actions"><span class="assignee-chip"><span class="assignee-avatar">${escapeHtml(initials(person.name))}</span>${escapeHtml(person.name)}</span><button class="button button-secondary action-button" data-edit-person="${escapeHtml(person.id)}">Editar</button></div></div>`; }).join("") : '<div class="secondary-empty">Nenhuma pessoa cadastrada.</div>'}</div>`;
    target.querySelector("#new-person-button").addEventListener("click", () => openPersonDialog());
    target.querySelectorAll("[data-edit-person]").forEach((button) => button.addEventListener("click", () => openPersonDialog(button.dataset.editPerson)));
  } else if (view === "notifications") {
    const upcoming = tasks.filter((task) => task.end && !["Concluída", "Cancelada"].includes(task.status) && dateDistance(task.end) <= 1 && dateDistance(task.end) >= 0).sort((a, b) => a.end.localeCompare(b.end));
    target.innerHTML = `<div class="eyebrow"><span class="eyebrow-rule"></span> LEMBRETES LOCAIS</div><h1>Notificações</h1><p class="section-description">Atividades com encerramento previsto para amanhã ou hoje.</p><div class="secondary-list">${upcoming.length ? upcoming.map((task) => `<div class="secondary-row"><div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.project)} · ${(task.people || []).map(escapeHtml).join(", ") || "Sem responsável"}</small></div><span class="status-pill status-blocked">${dateDistance(task.end) === 0 ? "Vence hoje" : "Vence amanhã"}</span></div>`).join("") : '<div class="secondary-empty">Nenhum lembrete próximo no momento.</div>'}</div>`;
  } else if (view === "settings") {
    target.innerHTML = `<div class="eyebrow"><span class="eyebrow-rule"></span> DADOS LOCAIS</div><h1>Configurações e backup</h1><p class="section-description">Gerencie times externos, faça cópias dos dados e importe feriados.</p><div class="secondary-list"><div class="secondary-row"><div><strong>Backup dos dados</strong><small>Atividades, times e feriados cadastrados neste navegador.</small></div><span>${tasks.length} atividades</span></div><div class="secondary-row"><div><strong>Feriados importados</strong><small>Datas carregadas de arquivos de calendário .ics.</small></div><span>${holidays.length} datas</span></div></div><div class="settings-actions"><button class="button button-primary" id="settings-export">⇧ Exportar backup</button><button class="button button-secondary" id="settings-import">⇩ Importar backup</button><button class="button button-secondary" id="settings-ics">＋ Importar calendário .ics</button></div>`;
    renderTeamSettings(target);
    target.querySelector("#settings-export").addEventListener("click", exportBackup);
    target.querySelector("#settings-import").addEventListener("click", () => document.querySelector("#backup-file").click());
    target.querySelector("#settings-ics").addEventListener("click", () => document.querySelector("#ics-file").click());
  }
}

function renderTeamSettings(target) {
  const section = document.createElement("section");
  section.className = "team-settings";
  section.innerHTML = `<div class="team-settings-heading"><div><h2>Times externos</h2><p>Cadastre as equipes que podem executar atividades para o seu time.</p></div></div><form class="team-add-form" id="team-add-form"><input id="new-team-name" maxlength="80" required placeholder="Nome do time" aria-label="Nome do time externo" /><button class="button button-secondary" type="submit"><span class="button-symbol">＋</span> Adicionar time</button></form><div class="team-list">${teams.length ? teams.map((team) => `<div class="team-list-row"><strong>${escapeHtml(team.name)}</strong><div><button class="button button-secondary action-button" data-rename-team="${escapeHtml(team.id)}">Renomear</button><button class="button button-secondary action-button team-delete-button" data-delete-team="${escapeHtml(team.id)}">Remover</button></div></div>`).join("") : '<p class="team-list-empty">Nenhum time externo cadastrado.</p>'}</div>`;
  target.querySelector(".settings-actions").before(section);
  section.querySelector("#team-add-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = section.querySelector("#new-team-name").value.trim();
    if (!name) {
      showToast("Informe o nome do time.");
      return;
    }
    if (teams.some((team) => team.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      showToast("Já existe um time com esse nome.");
      return;
    }
    teams = [...teams, { id: crypto.randomUUID(), name }];
    saveAll();
    renderSecondary("settings");
    renderTable();
    showToast("Time externo cadastrado.");
  });
  section.querySelectorAll("[data-rename-team]").forEach((button) => button.addEventListener("click", () => {
    const team = teams.find((item) => item.id === button.dataset.renameTeam);
    if (!team) return;
    const name = window.prompt("Novo nome do time", team.name)?.trim();
    if (!name || name === team.name) return;
    if (teams.some((item) => item.id !== team.id && item.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      showToast("Já existe um time com esse nome.");
      return;
    }
    teams = teams.map((item) => item.id === team.id ? { ...item, name } : item);
    saveAll();
    renderSecondary("settings");
    renderTable();
    showToast("Time renomeado.");
  }));
  section.querySelectorAll("[data-delete-team]").forEach((button) => button.addEventListener("click", () => {
    const team = teams.find((item) => item.id === button.dataset.deleteTeam);
    if (!team) return;
    if (tasks.some((task) => (task.teamIds || []).includes(team.id))) {
      showToast("Remova esse time das atividades antes de excluí-lo.");
      return;
    }
    if (!confirm(`Remover o time “${team.name}” do cadastro?`)) return;
    teams = teams.filter((item) => item.id !== team.id);
    saveAll();
    renderSecondary("settings");
    renderTable();
    showToast("Time removido.");
  }));
}

function renderChangelog() {
  const target = document.querySelector("#changelog-view");
  const entries = [...changelog].sort((first, second) => {
    const firstVersion = first.version.split(".").map(Number);
    const secondVersion = second.version.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (firstVersion[index] !== secondVersion[index]) return secondVersion[index] - firstVersion[index];
    }
    return 0;
  });
  target.innerHTML = `<div class="eyebrow"><span class="eyebrow-rule"></span> HISTÓRICO DE VERSÕES</div><h1>Changelog</h1><p class="section-description">Novidades, melhorias e correções publicadas no C_Planner.</p><div class="changelog-version-strip"><div><span>Versão instalada</span><strong id="installed-version">Consultando...</strong></div></div><div class="changelog-list">${entries.length ? entries.map((entry) => `<article class="changelog-entry"><header><h2>v${escapeHtml(entry.version)}</h2>${entry.date ? `<time datetime="${escapeHtml(entry.date)}">${escapeHtml(new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(`${entry.date}T12:00:00`)))}</time>` : ""}</header><ul>${(entry.changes || []).map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul></article>`).join("") : '<p class="changelog-empty">Ainda não há alterações publicadas. As próximas versões aparecerão aqui.</p>'}</div>`;
  const installedVersion = document.querySelector("#installed-version");
  if (!window.cPlanner?.getInstalledVersion) {
    installedVersion.textContent = `v${APP_VERSION}`;
    return;
  }
  window.cPlanner.getInstalledVersion().then((version) => {
    if (installedVersion.isConnected) installedVersion.textContent = `v${version}`;
  }).catch(() => {
    if (installedVersion.isConnected) installedVersion.textContent = "Indisponível";
  });
}

function addPositionFrom(sourcePosition, direction, sourceId = "") {
  const nodeWidth = 228;
  const nodeHeight = 118;
  const gap = 90;
  const origin = sourcePosition || { x: 360, y: 210 };
  const offsets = {
    left: { x: -nodeWidth - gap, y: 0 },
    up: { x: 0, y: -nodeHeight - gap },
    down: { x: 0, y: nodeHeight + gap },
    right: { x: nodeWidth + gap, y: 0 },
  };
  const offset = offsets[direction] || offsets.right;
  let candidate = { x: Math.max(24, origin.x + offset.x), y: Math.max(24, origin.y + offset.y) };
  const occupied = Object.entries(graphPositions).filter(([id]) => id !== sourceId).map(([, position]) => position);
  const overlaps = (position) => occupied.some((other) => position.x < other.x + nodeWidth + 24
    && position.x + nodeWidth + 24 > other.x
    && position.y < other.y + nodeHeight + 24
    && position.y + nodeHeight + 24 > other.y);
  let attempts = 0;
  while (overlaps(candidate) && attempts < 8) {
    attempts += 1;
    if (direction === "left" || direction === "right") candidate.y += nodeHeight + 30;
    else candidate.x += nodeWidth + 30;
  }
  return candidate;
}

function renderFlowchart() {
  const projectSelect = document.querySelector("#flow-project-select");
  const visibleProjects = [...projects].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  projectSelect.innerHTML = `<option value="">Selecione um projeto</option>${visibleProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}${project.status === "Encerrado" ? " · Encerrado" : ""}</option>`).join("")}`;
  if (!visibleProjects.some((project) => project.id === selectedFlowProjectId)) selectedFlowProjectId = "";
  projectSelect.value = selectedFlowProjectId;
  const project = projects.find((item) => item.id === selectedFlowProjectId);
  const projectDeliverables = project ? deliverables.filter((deliverable) => deliverable.projectId === project.id && !deliverable.hiddenFromFlowchart && deliverable.phase !== BACKLOG_PHASE) : [];
  const projectTasks = project ? tasks.filter((task) => task.project === project.name || (task.projectLinks || []).includes(project.id)) : [];
  const projectPhases = project ? [...new Set([...(project.phases || []), ...projectDeliverables.map((item) => item.phase).filter(Boolean)])].filter((phase) => phase !== BACKLOG_PHASE) : [];
  const projectDeliverableIds = new Set(projectDeliverables.map((item) => item.id));
  const taskDeliverablePaths = new Map(projectTasks.map((task) => [task.id, new Set(getTaskDeliverableIds(task).filter((id) => projectDeliverableIds.has(id)))]));
  for (let pass = 0; pass < projectTasks.length; pass += 1) {
    let changed = false;
    for (const edge of graphEdges) {
      if (!edge.source.startsWith("task:") || !edge.target.startsWith("task:")) continue;
      const sourceId = edge.source.slice("task:".length);
      const targetId = edge.target.slice("task:".length);
      const sourcePaths = taskDeliverablePaths.get(sourceId);
      const targetPaths = taskDeliverablePaths.get(targetId);
      if (!sourcePaths || !targetPaths) continue;
      for (const deliverableId of targetPaths) {
        if (sourcePaths.has(deliverableId)) continue;
        sourcePaths.add(deliverableId);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const nodes = [
    ...(project ? [{ id: `project:${project.id}`, type: "project", record: project }] : []),
    ...projectPhases.map((phase, index) => ({ id: `phase:${project.id}:${index}`, type: "phase", record: { id: `${project.id}:${index}`, projectId: project.id, name: phase,     phaseIndex: index, completedAt: project.completedPhases?.[phase] || "" } })),
        ...projectDeliverables.map((deliverable) => ({ id: `deliverable:${deliverable.id}`, type: "deliverable", record: { ...deliverable, completed: isDeliverableCompleted(deliverable), completedAt: deliverable.completedAt || project.completedPhases?.[deliverable.phase] || "", phaseIndex: Math.max(0, projectPhases.indexOf(deliverable.phase || BACKLOG_PHASE)) } })),
    ...projectTasks.flatMap((task) => {
      const pathDeliverables = [...(taskDeliverablePaths.get(task.id) || [])];
      return pathDeliverables.map((deliverableId) => {
        const deliverable = projectDeliverables.find((item) => item.id === deliverableId);
        const phase = deliverable?.phase || BACKLOG_PHASE;
        const phaseIndex = Math.max(0, projectPhases.indexOf(phase));
        const visualId = `task:${task.id}:path:${deliverableId}`;
        return { id: visualId, type: "task", record: { ...task, teamNames: getTaskTeamNames(task), visualId, recordId: task.id, phase, phaseIndex, pathDeliverableId: deliverableId } };
      });
    }),
  ];
  const nodesByTask = new Map();
  for (const node of nodes.filter((item) => item.type === "task")) {
    const recordId = node.record.recordId || node.record.id;
    if (!nodesByTask.has(recordId)) nodesByTask.set(recordId, []);
    nodesByTask.get(recordId).push(node);
  }
  const expandedEdges = [];
  const findVisualNodes = (id) => {
    if (id.startsWith("task:")) return nodesByTask.get(id.slice("task:".length).split(":path:")[0]) || [];
    return nodes.filter((node) => node.id === id);
  };
  for (const edge of graphEdges) {
    if (edge.relation === "phase-deliverable" || edge.source.startsWith("phase:")) continue;
    const sourceNodes = findVisualNodes(edge.source);
    const targetNodes = findVisualNodes(edge.target);
    for (const source of sourceNodes) {
      for (const target of targetNodes) {
        if (source.type === "task" && target.type === "task" && source.record.pathDeliverableId !== target.record.pathDeliverableId) continue;
        if (edge.relation === "task-deliverable" && source.type === "task" && target.type === "deliverable" && source.record.pathDeliverableId !== target.record.id) continue;
        if (source.type === "task" && target.type === "task" && source.record.pathDeliverableId !== target.record.pathDeliverableId) continue;
        expandedEdges.push({ ...edge, source: source.id, target: target.id, originalSource: edge.source, originalTarget: edge.target });
      }
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = expandedEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
    && !(edge.originalSource.startsWith("project:") && edge.originalTarget.startsWith("deliverable:")
      && tasks.some((task) => getTaskDeliverableIds(task).includes(edge.originalTarget.slice("deliverable:".length))))
    && !(["task-deliverable", "project-deliverable"].includes(edge.kind) && edge.userCreated !== true));
  graphEdges = graphEdges.filter((edge) => edge.relation !== "phase-deliverable" && !edge.source.startsWith("phase:"));
  saveAll();
  const hasNodes = nodes.length > 0;
  document.querySelector("#flow-empty").classList.toggle("hidden", hasNodes);
  document.querySelector("#flow-canvas").classList.toggle("hidden", !hasNodes);
  document.querySelector("#flow-empty-title").textContent = "Selecione ou cadastre um projeto";
  document.querySelector("#flow-empty-description").textContent = !project
    ? "O projeto será o primeiro bloco. Use o botão + para acrescentar atividades e entregáveis em qualquer direção."
    : "O projeto é o bloco de origem. Use + ao redor de qualquer bloco para criar uma etapa em direção específica.";
  const disabled = !project || project.status === "Encerrado";
  document.querySelector("#auto-layout-button").disabled = !hasNodes;
  const emptyAction = document.querySelector("#flow-empty-action");
  emptyAction.disabled = false;
  emptyAction.classList.toggle("hidden", Boolean(project));
  emptyAction.textContent = "＋ Cadastrar projeto";
  if (flowchart) {
    flowchart.draw({ nodes, edges, positions: graphPositions });
    deliverablesToPosition.clear();
  }
}

function openAddTypeDialog(sourceId, direction, sourcePosition, sourcePhase = "") {
  pendingFlowCreation = { sourceId, direction, sourcePosition, sourcePhase };
  const isTask = sourceId.startsWith("task:");
  const isDeliverable = sourceId.startsWith("deliverable:");
  const first = document.querySelector("#choose-activity-type");
  const second = document.querySelector("#choose-deliverable-type");
  document.querySelector("#add-type-direction").textContent = isTask ? "Escolha a relação com esta atividade." : isDeliverable ? "Adicione uma atividade necessária para este entregável." : "Escolha o que deseja adicionar ao projeto.";
  first.innerHTML = isTask ? '<span class="add-type-icon">←</span> Atividade anterior' : '<span class="add-type-icon">▣</span> Atividade';
  first.dataset.action = isTask || isDeliverable ? "before" : "after";
  second.innerHTML = isTask ? '<span class="add-type-icon">→</span> Atividade posterior' : '<span class="add-type-icon">◆</span> Entregável';
  second.dataset.action = isTask ? "after" : "deliverable";
  second.hidden = isDeliverable;
  document.querySelector("#add-type-dialog").showModal();
}

function chooseNewActivity(relation = "after") {
  const project = projects.find((item) => item.id === selectedFlowProjectId);
  if (!project) return showToast("Selecione um projeto para adicionar blocos.");
  const sourceId = pendingFlowCreation?.sourceId || `project:${project.id}`;
  const sourceTask = sourceId.startsWith("task:") ? tasks.find((task) => `task:${task.id}` === sourceId) : null;
  const inheritedDeliverableId = sourceId.startsWith("deliverable:") ? sourceId.slice("deliverable:".length) : getTaskDeliverableIds(sourceTask || {}).find((id) => {
    const deliverable = deliverables.find((item) => item.id === id && item.projectId === project.id);
    return deliverable && (!pendingFlowCreation?.sourcePhase || (deliverable.phase || BACKLOG_PHASE) === pendingFlowCreation.sourcePhase);
  }) || "";
  if (inheritedDeliverableId && isDeliverableCompleted(deliverables.find((item) => item.id === inheritedDeliverableId))) {
    document.querySelector("#add-type-dialog").close();
    return showToast("Este entregável está concluído e não aceita novas atividades. Reabra-o para continuar.");
  }
  const direction = relation === "before" ? "left" : "right";
  const sourcePosition = pendingFlowCreation?.sourcePosition;
  document.querySelector("#add-type-dialog").close();
  pendingFlowCreation = { sourceId, direction, sourcePosition, relation };
  openTaskDialog("", project.name, inheritedDeliverableId);
}

function chooseNewDeliverable() {
  const project = projects.find((item) => item.id === selectedFlowProjectId);
  if (!project) return showToast("Selecione um projeto para adicionar blocos.");
  document.querySelector("#add-type-dialog").close();
  openProjectDialog(project.id);
}

function openShareDialog() {
  const project = projects.find((item) => item.id === selectedFlowProjectId);
  const projectDeliverables = deliverables.filter((item) => item.projectId === project?.id && !isDeliverableCompleted(item));
  const availableTasks = tasks.filter((task) => !projectDeliverables.every((deliverable) => getTaskDeliverableIds(task).includes(deliverable.id)));
  if (!projectDeliverables.length) return showToast("Crie primeiro um entregável neste projeto.");
  if (!availableTasks.length) return showToast("Não há atividades de outros projetos para compartilhar.");
  document.querySelector("#share-task-select").innerHTML = availableTasks.map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.name)} · ${escapeHtml(task.project)}</option>`).join("");
  document.querySelector("#share-deliverable-select").innerHTML = projectDeliverables.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  document.querySelector("#share-dialog").showModal();
}

function handleShareSave(event) {
  event.preventDefault();
  const taskId = document.querySelector("#share-task-select").value;
  const deliverableId = document.querySelector("#share-deliverable-select").value;
  const project = projects.find((item) => item.id === selectedFlowProjectId);
  const deliverable = deliverables.find((item) => item.id === deliverableId);
  const task = tasks.find((item) => item.id === taskId);
  if (!project || !deliverable || !task) return showToast("Selecione um bloco e um entregável válidos.");
  if (task.project !== project.name) task.projectLinks = [...new Set([...(task.projectLinks || []), project.id])];
  task.sharedDeliverableIds = [...new Set([...(task.sharedDeliverableIds || []), deliverable.id])];
  const source = `task:${task.id}`;
  const target = `deliverable:${deliverable.id}`;
  if (!graphEdges.some((edge) => edge.source === source && edge.target === target)) graphEdges.push({ source, target, blocking: false, userCreated: true });
  deliverablesToPosition.add(deliverable.id);
  saveAll();
  document.querySelector("#share-dialog").close();
  renderFlowchart();
  renderTable();
  showToast("Bloco existente vinculado sem duplicar a atividade.");
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".page-section").forEach((section) => section.classList.add("hidden"));
  document.querySelector(`#${view}-view`).classList.remove("hidden");
  const labels = { flowchart: "Fluxograma", team: "Tabela do time", projects: "Projetos", people: "Pessoas", notifications: "Notificações", settings: "Configurações e backup", changelog: "Changelog" };
  document.querySelector("#breadcrumb-current").textContent = labels[view];
  if (view === "flowchart") {
    renderFlowchart();
    flowchart?.resetView();
  }
  else if (view === "changelog") renderChangelog();
  else if (view !== "team") renderSecondary(view);
}

function openTaskDialog(id = "", defaultProject = "", defaultDeliverableId = "") {
  const task = tasks.find((item) => item.id === id);
  const taskProjectName = task?.project || defaultProject;
  const initialDeliverableId = task?.deliverableId || defaultDeliverableId;
  elements.form.reset();
  refreshTaskOptions(taskProjectName, initialDeliverableId);
  document.querySelector("#task-id").value = task?.id || "";
  document.querySelector("#dialog-title").textContent = task ? "Editar atividade" : "Nova atividade";
  document.querySelector("#task-name").value = task?.name || "";
  document.querySelector("#task-project").value = task?.project || defaultProject || "";
  document.querySelector("#task-deliverable").value = initialDeliverableId || "";
  document.querySelector("#task-execution-type").value = task?.executionType || "internal";
  document.querySelector("#task-people").value = task?.executionType === "external" ? "" : (task?.people || []).join(", ");
  renderTaskTeamOptions(task?.teamIds || []);
  updateTaskExecutionFields();
  document.querySelector("#task-start").value = task?.start || "";
  document.querySelector("#task-end").value = task?.end || "";
  document.querySelector("#task-actual-start").value = task?.actualStart || "";
  document.querySelector("#task-status").value = task?.status || "Não iniciada";
  document.querySelector("#task-priority").value = task?.priority || "Normal";
  document.querySelector("#task-effort").value = task?.effort || "";
  document.querySelector("#task-actual-end").value = task?.actualEnd || "";
  document.querySelector("#task-description").value = task?.description || "";
  elements.dialog.showModal();
}

function refreshTaskOptions(selectedProject = "", selectedDeliverableId = "") {
  const projectSelect = document.querySelector("#task-project");
  const activeProjects = projects.filter((project) => project.status !== "Encerrado");
  const selectedIsClosed = selectedProject && !activeProjects.some((project) => project.name === selectedProject);
  const options = [...activeProjects.map((project) => project.name)];
  if (selectedIsClosed) options.push(selectedProject);
  projectSelect.innerHTML = `<option value="">Selecione um projeto</option>${options.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  projectSelect.value = selectedProject;
  refreshDeliverableOptions(selectedProject, selectedDeliverableId);
  closePeopleSuggestions();
}

function renderTaskTeamOptions(selectedTeamIds = []) {
  const options = document.querySelector("#task-team-options");
  options.innerHTML = teams.length ? teams.map((team) => `<label class="team-checkbox"><input type="checkbox" value="${escapeHtml(team.id)}" ${selectedTeamIds.includes(team.id) ? "checked" : ""} /><span>${escapeHtml(team.name)}</span></label>`).join("") : '<span class="field-note">Nenhum time cadastrado. Adicione nomes em Configurações.</span>';
}

function updateTaskExecutionFields() {
  const isExternal = document.querySelector("#task-execution-type").value === "external";
  document.querySelector("#task-people-field").classList.toggle("hidden", isExternal);
  document.querySelector("#task-teams-field").classList.toggle("hidden", !isExternal);
  if (isExternal) closePeopleSuggestions();
}

function closePeopleSuggestions() {
  const input = document.querySelector("#task-people");
  const suggestions = document.querySelector("#people-suggestions");
  suggestions.hidden = true;
  input.setAttribute("aria-expanded", "false");
  suggestions.replaceChildren();
}

function updatePeopleSuggestions() {
  const input = document.querySelector("#task-people");
  const suggestions = document.querySelector("#people-suggestions");
  const parts = input.value.split(",");
  const query = parts.at(-1).trim().toLocaleLowerCase("pt-BR");
  const selected = new Set(parts.slice(0, -1).map((name) => name.trim().toLocaleLowerCase("pt-BR")));
  const matches = people.filter((person) => !selected.has(person.name.toLocaleLowerCase("pt-BR"))
    && person.name.toLocaleLowerCase("pt-BR").includes(query));
  suggestions.replaceChildren(...matches.map((person) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "people-suggestion";
    option.setAttribute("role", "option");
    option.textContent = person.name;
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      const completedNames = parts.slice(0, -1).map((name) => name.trim()).filter(Boolean);
      input.value = [...completedNames, person.name, ""].join(", ");
      closePeopleSuggestions();
      input.focus();
    });
    return option;
  }));
  suggestions.hidden = matches.length === 0;
  input.setAttribute("aria-expanded", String(matches.length > 0));
}

function refreshDeliverableOptions(projectName, selectedDeliverableId = "") {
  const project = projects.find((item) => item.name === projectName);
  const projectDeliverables = project ? deliverables.filter((item) => item.projectId === project.id && (item.id === selectedDeliverableId || !isDeliverableCompleted(item))) : [];
  const select = document.querySelector("#task-deliverable");
  select.innerHTML = `<option value="">Selecione um entregável</option>${projectDeliverables.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${isDeliverableCompleted(item) ? " (concluído)" : ""}</option>`).join("")}`;
  select.disabled = projectDeliverables.length === 0;
  select.value = selectedDeliverableId;
}

function hasGraphPath(startId, targetId, edges) {
  const pending = [startId];
  const visited = new Set();
  while (pending.length) {
    const currentId = pending.pop();
    if (currentId === targetId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    for (const edge of edges) {
      if (edge.source === currentId && !visited.has(edge.target)) pending.push(edge.target);
    }
  }
  return false;
}

function handleTaskSave(event) {
  event.preventDefault();
  const id = document.querySelector("#task-id").value || crypto.randomUUID();
  const oldTask = tasks.find((item) => item.id === id);
  const projectName = document.querySelector("#task-project").value.trim();
  const deliverableId = document.querySelector("#task-deliverable").value;
  const end = document.querySelector("#task-end").value;
  const status = document.querySelector("#task-status").value;
  const enteredActualStart = document.querySelector("#task-actual-start").value;
  const actualStart = enteredActualStart || (status === "Em andamento" && (!oldTask || oldTask.status !== "Em andamento") ? localDateValue() : "");
  const executionType = document.querySelector("#task-execution-type").value;
  const selectedPeople = executionType === "internal" ? splitList(document.querySelector("#task-people").value) : [];
  const selectedTeamIds = executionType === "external" ? [...document.querySelectorAll("#task-team-options input:checked")].map((input) => input.value) : [];
  const peopleByName = new Map(people.map((person) => [person.name.toLocaleLowerCase("pt-BR"), person.name]));
  const unknownPeople = selectedPeople.filter((name) => !peopleByName.has(name.toLocaleLowerCase("pt-BR")));
  const project = projects.find((item) => item.name === projectName);
  if (!project || (project.status === "Encerrado" && project.name !== oldTask?.project)) {
    showToast("Cadastre ou selecione um projeto ativo antes de salvar a atividade.");
    return;
  }
  if (deliverableId && !deliverables.some((item) => item.id === deliverableId && item.projectId === project.id)) {
    showToast("Selecione um entregável deste projeto.");
    return;
  }
  if (deliverableId && deliverableId !== oldTask?.deliverableId && isDeliverableCompleted(deliverables.find((item) => item.id === deliverableId))) {
    showToast("Este entregável está concluído e não aceita novas atividades.");
    return;
  }
  if (unknownPeople.length) {
    showToast("Cadastre as pessoas responsáveis antes de vinculá-las à atividade.");
    return;
  }
  if (executionType === "external" && !selectedTeamIds.length) {
    showToast("Selecione pelo menos um time externo responsável.");
    return;
  }
  const assignedPeople = selectedPeople.map((name) => peopleByName.get(name.toLocaleLowerCase("pt-BR")));
  const task = {
    id,
    name: document.querySelector("#task-name").value.trim(),
    project: projectName,
    projectLinks: oldTask?.projectLinks || [],
    deliverableId: deliverableId || "",
    sharedDeliverableIds: oldTask?.sharedDeliverableIds || [],
    executionType,
    teamIds: selectedTeamIds,
    people: assignedPeople,
    start: document.querySelector("#task-start").value,
    end,
    actualStart,
    status,
    priority: document.querySelector("#task-priority").value,
    effort: Number(document.querySelector("#task-effort").value) || 0,
    actualEnd: document.querySelector("#task-actual-end").value || (status === "Concluída" ? new Date().toISOString().slice(0, 10) : ""),
    description: document.querySelector("#task-description").value.trim(),
    replans: oldTask?.replans || [],
  };
  if (task.start && task.end && task.end < task.start) {
    showToast("A data de término precisa ser igual ou posterior à data de início.");
    return;
  }
  if (oldTask && (oldTask.start !== task.start || oldTask.end !== task.end)) {
    task.replans.push({ oldStart: oldTask.start, oldEnd: oldTask.end, newStart: task.start, newEnd: task.end, changedAt: new Date().toISOString(), reason: "" });
  }
  const taskNodeId = `task:${task.id}`;
  const sourceId = oldTask ? taskNodeId : pendingFlowCreation?.sourceId || `project:${project.id}`;
  const deliverableNodeId = task.deliverableId ? `deliverable:${task.deliverableId}` : "";
  const before = !oldTask && (sourceId.startsWith("deliverable:") || (sourceId.startsWith("task:") && pendingFlowCreation?.relation === "before"));
  if (!oldTask && sourceId.startsWith("deliverable:") && deliverableNodeId !== sourceId) {
    showToast("Selecione o entregável a partir do qual a atividade foi criada.");
    return;
  }
  const sourceTask = !oldTask && sourceId.startsWith("task:") ? tasks.find((item) => `task:${item.id}` === sourceId) : null;
  const sourceDeliverableIds = sourceTask ? getTaskDeliverableIds(sourceTask).filter((deliverableId) => deliverables.some((item) => item.id === deliverableId && item.projectId === project.id)) : [];
  if (sourceDeliverableIds.length && !sourceDeliverableIds.includes(task.deliverableId)) {
    showToast("Selecione o mesmo entregável da atividade escolhida.");
    return;
  }
  const assignmentChanged = oldTask && oldTask.deliverableId !== task.deliverableId;
  const nextEdges = graphEdges.filter((edge) => !(assignmentChanged && edge.source === taskNodeId
    && (edge.relation === "task-deliverable" || (edge.kind === "task-deliverable" && edge.userCreated !== true))));
  const needsDeliveryEdge = deliverableNodeId && (!oldTask ? !before && !sourceId.startsWith("deliverable:") : assignmentChanged);
  if (needsDeliveryEdge && hasGraphPath(deliverableNodeId, sourceId, nextEdges)) {
    showToast("Essa associação criaria um ciclo no fluxograma. Escolha outro entregável.");
    return;
  }
  tasks = oldTask ? tasks.map((item) => item.id === id ? task : item) : [...tasks, task];
  graphEdges = nextEdges;
  if (!oldTask) {
    if (!before && sourceId.startsWith("task:") && deliverableNodeId) {
      graphEdges = graphEdges.filter((edge) => !(edge.source === sourceId && edge.target === deliverableNodeId && edge.relation === "task-deliverable"));
    }
    const edge = { source: before ? taskNodeId : sourceId, target: before ? sourceId : taskNodeId, blocking: false, userCreated: true, ...(sourceId.startsWith("deliverable:") ? { relation: "task-deliverable" } : {}) };
    if (!graphEdges.some((item) => item.source === edge.source && item.target === edge.target)) graphEdges.push(edge);
    if (!oldTask && sourceId.startsWith("deliverable:") && deliverableNodeId === sourceId) {
      const projectNodeId = `project:${project.id}`;
      const initialPathEdge = { source: projectNodeId, target: taskNodeId, blocking: false, userCreated: true };
      if (!graphEdges.some((item) => item.source === initialPathEdge.source && item.target === initialPathEdge.target)) graphEdges.push(initialPathEdge);
    }
    graphPositions[taskNodeId] = addPositionFrom(pendingFlowCreation?.sourcePosition || graphPositions[sourceId], pendingFlowCreation?.direction || "right", sourceId);
  }
  if (needsDeliveryEdge && !graphEdges.some((edge) => edge.source === taskNodeId && edge.target === deliverableNodeId)) {
    graphEdges.push({ source: taskNodeId, target: deliverableNodeId, blocking: false, userCreated: true, relation: "task-deliverable" });
  }
  if ((!oldTask || assignmentChanged) && task.deliverableId) {
    deliverablesToPosition.add(task.deliverableId);
    if (currentView !== "flowchart" || selectedFlowProjectId !== project.id) {
      const taskPositions = tasks.filter((item) => getTaskDeliverableIds(item).includes(task.deliverableId))
        .map((item) => graphPositions[`task:${item.id}`]).filter(Boolean);
      const position = graphPositions[deliverableNodeId];
      if (taskPositions.length) {
        const rightmost = Math.max(...taskPositions.map((item) => item.x));
        if (!position || position.x < rightmost + 252) {
          graphPositions[deliverableNodeId] = addPositionFrom({ x: rightmost, y: position?.y ?? taskPositions[0].y }, "right", deliverableNodeId);
        }
      }
    }
  }
  pendingFlowCreation = null;
  saveAll();
  elements.dialog.close();
  renderMetrics();
  renderTable();
  if (currentView === "flowchart") {
    renderFlowchart();
    if (!oldTask) {
      if (task.deliverableId) flowchart?.autoLayout([task.deliverableId], false);
      else flowchart?.autoLayout(null, false);
    }
  }
  else if (currentView !== "team") renderSecondary(currentView);
  showToast(oldTask ? "Atividade atualizada." : "Atividade adicionada à tabela do time.");
}

function handleQuickTaskStatusChange(id, status) {
  const task = tasks.find((item) => item.id === id);
  if (!task || !statuses.includes(status)) return;
  tasks = tasks.map((item) => item.id === id ? {
    ...item,
    status,
    actualStart: status === "Em andamento" && item.status !== "Em andamento" ? (item.actualStart || localDateValue()) : (item.actualStart || ""),
    actualEnd: status === "Concluída" ? (item.actualEnd || new Date().toISOString().slice(0, 10)) : "",
  } : item);
  saveAll();
  renderMetrics();
  renderTable();
  renderFlowchart();
  showToast("Status da atividade atualizado.");
}

function currentDialogProject() {
  return projects.find((item) => item.id === document.querySelector("#project-id").value);
}

function updateProjectCompletionUi() {
  const project = currentDialogProject();
  renderProjectHistory();
  document.querySelectorAll("#project-phases-list .project-phase-row").forEach((row) => {
    const date = project?.completedPhases?.[row.dataset.phase];
    const badge = row.querySelector(".completion-badge");
    const button = row.querySelector(".completion-toggle");
    if (badge) { badge.textContent = date ? `Concluída em ${formatCompletionDate(date)}` : ""; badge.classList.toggle("hidden", !date); }
    if (button) button.textContent = date ? "Reabrir" : "Concluir";
    row.classList.toggle("is-completed", Boolean(date));
  });
  document.querySelectorAll("#project-deliverable-rows tr[data-deliverable-id]").forEach((row) => {
    const deliverable = deliverables.find((item) => item.id === row.dataset.deliverableId);
    const done = deliverable ? isDeliverableCompleted(deliverable) : false;
    const date = deliverable?.completedAt || project?.completedPhases?.[deliverable?.phase];
    const badge = row.querySelector(".completion-badge");
    const button = row.querySelector(".completion-toggle");
    if (badge) { badge.textContent = done ? `Concluído em ${formatCompletionDate(date)}` : ""; badge.classList.toggle("hidden", !done); }
    if (button) { button.textContent = done ? "Reabrir" : "Concluir"; button.classList.toggle("hidden", !deliverable); }
    row.classList.toggle("is-completed", done);
  });
}

function renderProjectPhaseList(phases) {
  const phaseList = document.querySelector("#project-phases-list");
  const orderedPhases = [...phases.filter((phase) => phase !== BACKLOG_PHASE), BACKLOG_PHASE];
  phaseList.innerHTML = orderedPhases.map((phase, index) => `<li class="project-phase-row" data-phase="${escapeHtml(phase)}"><span class="phase-order">${index + 1}</span><strong>${escapeHtml(phase)}</strong>${phase === BACKLOG_PHASE ? '<span class="phase-fixed-label">Fixo no final</span>' : `<span class="completion-badge hidden"></span><div class="phase-row-actions"><button class="button button-secondary completion-toggle" type="button" data-phase-complete="${escapeHtml(phase)}">Concluir</button><button class="icon-button phase-rename" type="button" data-phase-rename="${escapeHtml(phase)}" aria-label="Renomear fase ${escapeHtml(phase)}">···</button><button class="icon-button phase-move" type="button" data-phase-move="up" data-phase-index="${index}" aria-label="Mover ${escapeHtml(phase)} para cima" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-button phase-move" type="button" data-phase-move="down" data-phase-index="${index}" aria-label="Mover ${escapeHtml(phase)} para baixo">↓</button><button class="icon-button phase-remove" type="button" data-phase-remove="${escapeHtml(phase)}" aria-label="Remover fase ${escapeHtml(phase)}">×</button></div>`}</li>`).join("");
  phaseList.querySelectorAll("[data-phase-complete]").forEach((button) => button.addEventListener("click", () => {
    const project = currentDialogProject();
    if (!project || !project.phases.includes(button.dataset.phaseComplete)) return showToast("Salve o projeto antes de concluir esta fase.");
    togglePhaseCompletion(project.id, button.dataset.phaseComplete);
  }));
  phaseList.querySelectorAll("[data-phase-rename]").forEach((button) => button.addEventListener("click", () => {
    const oldName = button.dataset.phaseRename;
    if (currentDialogProject()?.completedPhases?.[oldName]) return showToast("Reabra a fase antes de renomeá-la.");
    const name = window.prompt("Novo nome da fase", oldName)?.trim();
    if (!name || name === oldName) return;
    const current = [...phaseList.querySelectorAll(".project-phase-row")].map((row) => row.dataset.phase);
    if (name.toLocaleLowerCase("pt-BR") === BACKLOG_PHASE.toLocaleLowerCase("pt-BR") || current.some((phase) => phase.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      showToast("O nome precisa ser único e diferente de Backlog.");
      return;
    }
    renderProjectPhaseList(current.map((phase) => phase === oldName ? name : phase));
    document.querySelectorAll("[data-deliverable-phase]").forEach((select) => {
      if (select.value === oldName) select.value = name;
    });
    refreshDeliverablePhaseOptions();
  }));
  phaseList.querySelectorAll("[data-phase-move]").forEach((button) => button.addEventListener("click", () => {
    const current = [...phaseList.querySelectorAll(".project-phase-row")].map((row) => row.dataset.phase);
    const index = Number(button.dataset.phaseIndex);
    const target = button.dataset.phaseMove === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= current.length - 1) return;
    [current[index], current[target]] = [current[target], current[index]];
    renderProjectPhaseList(current);
    refreshDeliverablePhaseOptions(current);
  }));
  phaseList.querySelectorAll("[data-phase-remove]").forEach((button) => button.addEventListener("click", () => {
    const removed = button.dataset.phaseRemove;
    if (currentDialogProject()?.completedPhases?.[removed]) return showToast("Reabra a fase antes de removê-la.");
    const current = [...phaseList.querySelectorAll(".project-phase-row")].map((row) => row.dataset.phase).filter((phase) => phase !== removed);
    document.querySelectorAll("[data-deliverable-phase]").forEach((select) => {
      if (select.value === removed) select.value = BACKLOG_PHASE;
    });
    renderProjectPhaseList(current);
    refreshDeliverablePhaseOptions(current);
    updateProjectCompletionUi();
  }));
}

function refreshDeliverablePhaseOptions(phases = [...document.querySelectorAll("#project-phases-list .project-phase-row")].map((row) => row.dataset.phase)) {
  const orderedPhases = [...phases.filter((phase) => phase !== BACKLOG_PHASE), BACKLOG_PHASE];
  document.querySelectorAll("[data-deliverable-phase]").forEach((select) => {
    const selected = orderedPhases.includes(select.value) ? select.value : BACKLOG_PHASE;
    select.innerHTML = orderedPhases.map((phase) => `<option value="${escapeHtml(phase)}">${escapeHtml(phase)}</option>`).join("");
    select.value = selected;
  });
}

function appendProjectDeliverableRow(deliverable = {}, phases = [...document.querySelectorAll("#project-phases-list .project-phase-row")].map((row) => row.dataset.phase)) {
  const row = document.createElement("tr");
  row.dataset.deliverableId = deliverable.id || "";
  row.innerHTML = `<td><input class="deliverable-name-input" data-deliverable-name maxlength="100" aria-label="Nome do entregável" value="${escapeHtml(deliverable.name || "")}" placeholder="Nome do entregável" /><span class="completion-badge hidden"></span></td><td><select data-deliverable-phase aria-label="Fase do entregável">${phases.map((phase) => `<option value="${escapeHtml(phase)}" ${phase === (deliverable.phase || BACKLOG_PHASE) ? "selected" : ""}>${escapeHtml(phase)}</option>`).join("")}</select></td><td class="deliverable-row-actions"><button class="button button-secondary completion-toggle hidden" type="button">Concluir</button><button class="icon-button deliverable-remove" type="button" aria-label="Remover entregável">×</button></td>`;
  row.querySelector(".completion-toggle").addEventListener("click", () => {
    toggleDeliverableCompletion(row.dataset.deliverableId);
    updateProjectCompletionUi();
  });
  row.querySelector(".deliverable-remove").addEventListener("click", () => {
    if (isDeliverableCompleted(deliverables.find((item) => item.id === row.dataset.deliverableId))) return showToast("Reabra o entregável antes de removê-lo.");
    row.remove();
    updateDeliverableEditorEmpty();
  });
  document.querySelector("#project-deliverable-rows").append(row);
  updateDeliverableEditorEmpty();
}

function updateDeliverableEditorEmpty() {
  const hasRows = document.querySelectorAll("#project-deliverable-rows tr").length > 0;
  document.querySelector("#deliverable-editor-empty").classList.toggle("hidden", hasRows);
}

function setProjectTab(tab) {
  document.querySelectorAll("[data-project-tab]").forEach((button) => {
    const active = button.dataset.projectTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".project-tab-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `project-panel-${tab}`));
}

function openProjectDialog(id = "") {
  const project = projects.find((item) => item.id === id);
  const form = document.querySelector("#project-form");
  form.reset();
  setProjectTab("info");
  document.querySelector("#project-id").value = project?.id || "";
  document.querySelector("#project-dialog-title").textContent = project ? "Editar projeto" : "Novo projeto";
  document.querySelector("#project-name").value = project?.name || "";
  document.querySelector("#project-status").value = project?.status || "Ativo";
  document.querySelector("#project-description").value = project?.description || "";
  document.querySelector("#project-requester").value = project?.requester || "";
  document.querySelector("#project-requested-via").value = project?.requestedVia || "";
  document.querySelector("#project-request-date").value = project?.requestDate || "";
  const projectDeliverables = project ? deliverables.filter((item) => item.projectId === project.id) : [];
  const phases = [...(project?.phases || projectDeliverables.map((item) => item.phase).filter((phase) => phase && phase !== BACKLOG_PHASE))].filter((phase) => phase !== BACKLOG_PHASE);
  renderProjectPhaseList([...new Set(phases), BACKLOG_PHASE]);
  document.querySelector("#new-project-phase").value = "";
  document.querySelector("#new-project-deliverable").value = "";
  document.querySelector("#project-deliverable-rows").replaceChildren();
  const orderedPhases = [...new Set(phases), BACKLOG_PHASE];
  refreshDeliverablePhaseOptions(orderedPhases);
  projectDeliverables.forEach((deliverable) => appendProjectDeliverableRow(deliverable, orderedPhases));
  updateDeliverableEditorEmpty();
  updateProjectCompletionUi();
  document.querySelector("#export-project-pdf").classList.toggle("hidden", !project);
  document.querySelector("#project-dialog").showModal();
}

function handleProjectSave(event) {
  event.preventDefault();
  const id = document.querySelector("#project-id").value || crypto.randomUUID();
  const oldProject = projects.find((item) => item.id === id);
  const name = document.querySelector("#project-name").value.trim();
  const duplicate = projects.some((project) => project.id !== id && project.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"));
  if (duplicate) {
    setProjectTab("info");
    document.querySelector("#project-name").focus();
    showToast("Já existe um projeto com esse nome.");
    return;
  }
  const phases = [...new Set([...document.querySelectorAll("#project-phases-list .project-phase-row")].map((row) => row.dataset.phase).filter((phase) => phase && phase !== BACKLOG_PHASE))];
  phases.push(BACKLOG_PHASE);
  const deliverableRows = [...document.querySelectorAll("#project-deliverable-rows tr")];
  const deliverableNames = deliverableRows.map((row) => row.querySelector("[data-deliverable-name]").value.trim()).filter(Boolean);
  if (new Set(deliverableNames.map((value) => value.toLocaleLowerCase("pt-BR"))).size !== deliverableNames.length) {
    showToast("Os nomes dos entregáveis precisam ser únicos neste projeto.");
    return;
  }
  const project = { ...oldProject, id, name, status: document.querySelector("#project-status").value, description: document.querySelector("#project-description").value.trim(), requester: document.querySelector("#project-requester").value.trim(), requestedVia: document.querySelector("#project-requested-via").value, requestDate: document.querySelector("#project-request-date").value, phases };
  const completedPhases = Object.fromEntries(Object.entries(oldProject?.completedPhases || {}).filter(([phase]) => phases.includes(phase)));
  project.completedPhases = completedPhases;
  const oldDeliverablesForCheck = deliverables.filter((item) => item.projectId === id);
  const movedIntoCompleted = deliverableRows.find((row) => {
    const phase = row.querySelector("[data-deliverable-phase]").value;
    const existing = oldDeliverablesForCheck.find((item) => item.id === row.dataset.deliverableId);
    return completedPhases[phase] && (!existing || existing.phase !== phase);
  });
  if (movedIntoCompleted) {
    setProjectTab("deliverables");
    showToast(`A fase “${movedIntoCompleted.querySelector("[data-deliverable-phase]").value}” está concluída e não aceita novos entregáveis.`);
    return;
  }
  if (oldProject && oldProject.name !== name) {
    tasks = tasks.map((task) => task.project === oldProject.name ? { ...task, project: name } : task);
  }
  projects = oldProject ? projects.map((item) => item.id === id ? project : item) : [...projects, project];
  if (!oldProject && currentView === "flowchart" && !selectedFlowProjectId) selectedFlowProjectId = id;
  const oldDeliverables = deliverables.filter((item) => item.projectId === id);
  const nextDeliverables = deliverableRows.map((row) => {
    const deliverableName = row.querySelector("[data-deliverable-name]").value.trim();
    if (!deliverableName) return null;
    const existing = oldDeliverables.find((item) => item.id === row.dataset.deliverableId)
      || oldDeliverables.find((item) => item.name.toLocaleLowerCase("pt-BR") === deliverableName.toLocaleLowerCase("pt-BR"));
    return { ...existing, id: existing?.id || crypto.randomUUID(), projectId: id, name: deliverableName, phase: phases.includes(row.querySelector("[data-deliverable-phase]").value) ? row.querySelector("[data-deliverable-phase]").value : BACKLOG_PHASE };
  }).filter(Boolean);
  const newDeliverables = nextDeliverables.filter((item) => !oldDeliverables.some((oldItem) => oldItem.id === item.id));
  const phasesChanged = JSON.stringify(oldProject?.phases || [BACKLOG_PHASE]) !== JSON.stringify(phases);
  const assignmentsChanged = nextDeliverables.some((item) => oldDeliverables.find((oldItem) => oldItem.id === item.id)?.phase !== item.phase);
  const shouldOrganizeFlow = !oldProject || newDeliverables.length > 0 || phasesChanged || assignmentsChanged;
  const nextDeliverableIds = new Set(nextDeliverables.map((item) => item.id));
  const removedDeliverableIds = new Set(oldDeliverables.filter((item) => !nextDeliverableIds.has(item.id)).map((item) => item.id));
  if (removedDeliverableIds.size) {
    tasks = tasks.map((task) => ({
      ...task,
      deliverableId: removedDeliverableIds.has(task.deliverableId) ? "" : task.deliverableId,
      sharedDeliverableIds: (task.sharedDeliverableIds || []).filter((deliverableId) => !removedDeliverableIds.has(deliverableId)),
    }));
    graphEdges = graphEdges.filter((edge) => ![...removedDeliverableIds].some((deliverableId) => edge.source === `deliverable:${deliverableId}` || edge.target === `deliverable:${deliverableId}`));
    for (const deliverableId of removedDeliverableIds) delete graphPositions[`deliverable:${deliverableId}`];
  }
  deliverables = [...deliverables.filter((item) => item.projectId !== id), ...nextDeliverables];
  if (pendingFlowCreation?.sourceId && currentView === "flowchart") {
    for (const deliverable of newDeliverables) {
      const sourceId = pendingFlowCreation.sourceId;
      const targetId = `deliverable:${deliverable.id}`;
      if (!graphEdges.some((edge) => edge.source === sourceId && edge.target === targetId)) graphEdges.push({ source: sourceId, target: targetId, blocking: false, userCreated: true });
      graphPositions[targetId] = addPositionFrom(pendingFlowCreation.sourcePosition || graphPositions[sourceId], pendingFlowCreation.direction || "right", sourceId);
    }
  }
  pendingFlowCreation = null;
  saveAll();
  document.querySelector("#project-dialog").close();
  renderMetrics();
  renderTable();
  if (currentView === "flowchart") {
    renderFlowchart();
    if (shouldOrganizeFlow) flowchart?.autoLayout(null, false);
  }
  else renderSecondary("projects");
  showToast(oldProject ? "Projeto atualizado." : "Projeto cadastrado.");
}

document.querySelector("#add-project-phase").addEventListener("click", () => {
  const input = document.querySelector("#new-project-phase");
  const name = input.value.trim();
  const phases = [...document.querySelectorAll("#project-phases-list .project-phase-row")].map((row) => row.dataset.phase);
  if (!name) {
    showToast("Informe o nome da fase.");
    input.focus();
    return;
  }
  if (name.toLocaleLowerCase("pt-BR") === BACKLOG_PHASE.toLocaleLowerCase("pt-BR")) {
    showToast("Backlog é uma fase reservada e fica sempre no final.");
    return;
  }
  if (phases.some((phase) => phase.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
    showToast("Já existe uma fase com esse nome no projeto.");
    return;
  }
  renderProjectPhaseList([...phases.filter((phase) => phase !== BACKLOG_PHASE), name, BACKLOG_PHASE]);
  refreshDeliverablePhaseOptions();
  input.value = "";
  input.focus();
});

document.querySelector("#new-project-phase").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.querySelector("#add-project-phase").click();
  }
});

document.querySelector("#add-project-deliverable").addEventListener("click", () => {
  const input = document.querySelector("#new-project-deliverable");
  const name = input.value.trim();
  if (!name) {
    showToast("Informe o nome do entregável.");
    input.focus();
    return;
  }
  const duplicate = [...document.querySelectorAll("#project-deliverable-rows [data-deliverable-name]")]
    .some((item) => item.value.trim().toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"));
  if (duplicate) {
    showToast("Já existe um entregável com esse nome no projeto.");
    input.focus();
    return;
  }
  const phases = [...document.querySelectorAll("#project-phases-list .project-phase-row")].map((row) => row.dataset.phase);
  appendProjectDeliverableRow({ name, phase: document.querySelector("#new-project-deliverable-phase").value }, phases);
  input.value = "";
  input.focus();
});

document.querySelector("#new-project-deliverable").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.querySelector("#add-project-deliverable").click();
  }
});

function openPersonDialog(id = "") {
  const person = people.find((item) => item.id === id);
  const form = document.querySelector("#person-form");
  form.reset();
  document.querySelector("#person-id").value = person?.id || "";
  document.querySelector("#person-dialog-title").textContent = person ? "Editar pessoa" : "Nova pessoa";
  document.querySelector("#person-name").value = person?.name || "";
  document.querySelector("#person-capacity").value = person?.capacityHoursPerDay || 8;
  document.querySelector("#person-dialog").showModal();
}

function handlePersonSave(event) {
  event.preventDefault();
  const id = document.querySelector("#person-id").value || crypto.randomUUID();
  const oldPerson = people.find((item) => item.id === id);
  const name = document.querySelector("#person-name").value.trim();
  const duplicate = people.some((person) => person.id !== id && person.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"));
  if (duplicate) {
    showToast("Já existe uma pessoa com esse nome.");
    return;
  }
  const person = { id, name, capacityHoursPerDay: Number(document.querySelector("#person-capacity").value) || 8 };
  if (oldPerson && oldPerson.name !== name) {
    tasks = tasks.map((task) => ({ ...task, people: (task.people || []).map((assigned) => assigned === oldPerson.name ? name : assigned) }));
  }
  people = oldPerson ? people.map((item) => item.id === id ? person : item) : [...people, person];
  saveAll();
  document.querySelector("#person-dialog").close();
  renderTable();
  renderSecondary("people");
  showToast(oldPerson ? "Pessoa atualizada." : "Pessoa cadastrada.");
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function exportBackup() {
  const backup = { format: "plano-de-projetos-backup", version: 6, exportedAt: new Date().toISOString(), tasks, holidays, projects, people, deliverables, teams, graphEdges: graphEdges.filter((edge) => edge.relation !== "phase-deliverable" && !edge.source.startsWith("phase:")), graphPositions, };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  downloadBlob(blob, `plano-projetos-backup-${new Date().toISOString().slice(0, 10)}.json`);
  showToast("Backup exportado.");
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (!backup || backup.format !== "plano-de-projetos-backup" || !Array.isArray(backup.tasks) || !Array.isArray(backup.holidays)) throw new Error("Formato inválido");
    if (!confirm(`O backup contém ${backup.tasks.length} atividades. Substituir os dados locais atuais?`)) return;
    tasks = backup.tasks;
    holidays = backup.holidays;
    projects = Array.isArray(backup.projects) ? backup.projects : deriveProjectsFromTasks(tasks);
    people = Array.isArray(backup.people) ? backup.people : derivePeopleFromTasks(tasks);
    deliverables = Array.isArray(backup.deliverables) ? backup.deliverables : [];
    teams = Array.isArray(backup.teams) ? backup.teams : [];
    graphEdges = Array.isArray(backup.graphEdges) ? backup.graphEdges : [];
    graphPositions = backup.graphPositions && typeof backup.graphPositions === "object" ? backup.graphPositions : {};
    migrateTaskExecution();
    migrateDeliverables();
    migrateProjectPhases();
    saveAll();
    renderMetrics();
    renderTable();
    if (currentView === "flowchart") renderFlowchart();
    else if (currentView !== "team") renderSecondary(currentView);
    showToast("Backup importado com sucesso.");
  } catch {
    showToast("Não foi possível ler esse backup. Confira se o arquivo é válido.");
  }
}

async function importIcs(file) {
  try {
    const text = (await file.text()).replace(/\r?\n[ \t]/g, "");
    const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
    const imported = [];
    for (const block of blocks) {
      const start = block.match(/^DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})/m);
      const summary = block.match(/^SUMMARY(?:;[^:]*)?:(.*)$/m);
      if (start) imported.push({ date: `${start[1]}-${start[2]}-${start[3]}`, name: summary ? unescapeIcs(summary[1]) : "Feriado" });
    }
    const existing = new Set(holidays.map((holiday) => holiday.date));
    const fresh = imported.filter((holiday) => !existing.has(holiday.date));
    if (!fresh.length) {
      showToast(imported.length ? "As datas desse calendário já estão cadastradas." : "Nenhum evento de dia inteiro foi encontrado no arquivo.");
      return;
    }
    if (!confirm(`Foram encontradas ${fresh.length} datas novas em ${imported.length} eventos. Importar?`)) return;
    holidays = [...holidays, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
    saveAll();
    if (currentView === "settings") renderSecondary("settings");
    showToast(`${fresh.length} feriados importados do calendário.`);
  } catch {
    showToast("Não foi possível ler esse calendário .ics.");
  }
}

function unescapeIcs(value) {
  return value.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

document.querySelectorAll(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
window.cPlanner?.onUpdateStatus((message) => showToast(message));
document.querySelector("#add-task-button").addEventListener("click", () => openTaskDialog());
document.querySelector("#empty-add-button").addEventListener("click", () => openTaskDialog());
document.querySelector("#export-button").addEventListener("click", exportBackup);
document.querySelector("#quick-backup").addEventListener("click", exportBackup);
document.querySelector("#close-dialog").addEventListener("click", () => elements.dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => {
  pendingFlowCreation = null;
  elements.dialog.close();
});
elements.dialog.addEventListener("close", () => { pendingFlowCreation = null; });
elements.form.addEventListener("submit", handleTaskSave);
document.querySelector("#task-execution-type").addEventListener("change", (event) => {
  const isExternal = event.target.value === "external";
  if (isExternal) {
    document.querySelector("#task-people").value = "";
    closePeopleSuggestions();
  } else {
    document.querySelectorAll("#task-team-options input").forEach((input) => { input.checked = false; });
  }
  updateTaskExecutionFields();
});
document.querySelector("#project-form").addEventListener("submit", handleProjectSave);
document.querySelectorAll("[data-project-tab]").forEach((button) => button.addEventListener("click", () => setProjectTab(button.dataset.projectTab)));
document.querySelector("#project-name").addEventListener("invalid", () => setProjectTab("info"));
document.querySelector("#person-form").addEventListener("submit", handlePersonSave);
document.querySelector("#share-form").addEventListener("submit", handleShareSave);
document.querySelector("#choose-activity-type").addEventListener("click", (event) => chooseNewActivity(event.currentTarget.dataset.action));
document.querySelector("#choose-deliverable-type").addEventListener("click", (event) => {
  if (event.currentTarget.dataset.action === "deliverable") chooseNewDeliverable();
  else chooseNewActivity(event.currentTarget.dataset.action);
});
document.querySelector("#close-add-type").addEventListener("click", () => {
  document.querySelector("#add-type-dialog").close();
  pendingFlowCreation = null;
});
const taskPeopleInput = document.querySelector("#task-people");
taskPeopleInput.addEventListener("focus", updatePeopleSuggestions);
taskPeopleInput.addEventListener("input", updatePeopleSuggestions);
taskPeopleInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("#people-suggestions").hidden) {
    event.preventDefault();
    event.stopPropagation();
    closePeopleSuggestions();
  } else if (event.key === "ArrowDown") {
    const firstOption = document.querySelector("#people-suggestions .people-suggestion");
    if (firstOption) {
      event.preventDefault();
      firstOption.focus();
    }
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".people-picker")) closePeopleSuggestions();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("#people-suggestions").hidden) {
    event.preventDefault();
    event.stopPropagation();
    closePeopleSuggestions();
  }
});
elements.dialog.addEventListener("close", closePeopleSuggestions);
document.querySelector("#task-project").addEventListener("change", (event) => refreshDeliverableOptions(event.target.value));
document.querySelectorAll("[data-close-dialog], [data-cancel-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialogId = button.dataset.closeDialog || button.dataset.cancelDialog;
    if (dialogId === "project-dialog") pendingFlowCreation = null;
    document.querySelector(`#${dialogId}`).close();
  });
});
document.querySelectorAll("#search-input, #project-filter, #phase-filter, #person-filter, #team-filter, #status-filter, #date-filter").forEach((control) => control.addEventListener("input", renderTable));
document.querySelector("#clear-filters").addEventListener("click", () => {
  document.querySelector("#search-input").value = "";
  document.querySelector("#project-filter").value = "";
  document.querySelector("#phase-filter").value = "";
  document.querySelector("#person-filter").value = "";
  document.querySelector("#team-filter").value = "";
  document.querySelector("#status-filter").value = "";
  document.querySelector("#date-filter").value = "";
  renderTable();
});
document.querySelectorAll(".view-toggle-button").forEach((button) => button.addEventListener("click", () => {
  groupByMode = button.dataset.group;
  document.querySelectorAll(".view-toggle-button").forEach((item) => item.classList.toggle("selected", item === button));
  renderTable();
}));
document.querySelector("#backup-file").addEventListener("change", (event) => {
  if (event.target.files[0]) importBackup(event.target.files[0]);
  event.target.value = "";
});
document.querySelector("#ics-file").addEventListener("change", (event) => {
  if (event.target.files[0]) importIcs(event.target.files[0]);
  event.target.value = "";
});

document.querySelector("#flow-project-select").addEventListener("change", (event) => {
  selectedFlowProjectId = event.target.value;
  renderFlowchart();
});
document.querySelector("#flow-empty-action").addEventListener("click", () => {
  openProjectDialog();
});
document.querySelector("#changelog-button").addEventListener("click", () => setView("changelog"));
document.querySelector("#auto-layout-button").addEventListener("click", () => flowchart?.autoLayout());

const flowContainer = document.querySelector("#flow-canvas");
flowchart = createFlowchart(flowContainer, {
  onTaskEdit: (id) => openTaskDialog(id),
  onTaskStatusChange: handleQuickTaskStatusChange,
  onTaskDelete: (id) => deleteTask(id),
  onDeliverableEdit: (id) => {
    const deliverable = deliverables.find((item) => item.id === id);
    if (deliverable) openProjectDialog(deliverable.projectId);
  },
  onDeliverableDelete: (id) => deleteDeliverable(id),
  onDeliverableComplete: (id) => toggleDeliverableCompletion(id),
  onPhaseComplete: (projectId, name) => togglePhaseCompletion(projectId, name),
  onAddBlock: (sourceId, direction, sourcePosition, sourcePhase) => {
    openAddTypeDialog(sourceId, direction, sourcePosition, sourcePhase);
  },
  onEdgesChange: (updatedEdges) => {
    const project = projects.find((item) => item.id === selectedFlowProjectId);
    const visibleTasks = tasks.filter((task) => task.project === project?.name || (task.projectLinks || []).includes(project?.id));
    const visibleDeliverables = deliverables.filter((item) => item.projectId === project?.id);
    const visibleIds = new Set([
      ...(project ? [`project:${project.id}`] : []),
      ...visibleTasks.map((task) => `task:${task.id}`),
      ...visibleDeliverables.map((item) => `deliverable:${item.id}`),
    ]);
    graphEdges = graphEdges.filter((edge) => !visibleIds.has(edge.source) || !visibleIds.has(edge.target)).concat(updatedEdges);
    saveAll();
  },
  onPositionsChange: (updatedPositions) => {
    graphPositions = { ...graphPositions, ...updatedPositions };
    saveAll();
  },
});

renderMetrics();
renderTable();
document.querySelector('#export-project-pdf').addEventListener('click', () => exportProjectPdf(document.querySelector('#project-id').value));
