import { Graph } from "@antv/x6";
import dagre from "dagre";

const NODE_WIDTH = 228;
const NODE_HEIGHT = 118;
const BLOCK_HEIGHT = 88;
const TASK_STATUSES = ["Não iniciada", "Em andamento", "Bloqueada", "Concluída", "Cancelada"];
const titleMeasureContext = document.createElement("canvas").getContext("2d");

function wrapNodeTitle(title) {
  const maxWidth = NODE_WIDTH - 28;
  titleMeasureContext.font = "700 12px Arial, helvetica, sans-serif";
  const measure = (text) => titleMeasureContext.measureText(text).width;
  const lines = [];
  let line = "";
  for (const word of String(title).trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let wordPart = "";
    for (const character of word) {
      if (measure(`${wordPart}${character}`) <= maxWidth) wordPart += character;
      else {
        lines.push(wordPart);
        wordPart = character;
      }
    }
    line = wordPart;
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines.join("\n");
  let lastLine = lines[1];
  while (lastLine && measure(`${lastLine}…`) > maxWidth) lastLine = lastLine.slice(0, -1);
  lines[1] = `${lastLine}…`;
  return lines.slice(0, 2).join("\n");
}

function initials(names = []) {
  return names.map((name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase()).filter(Boolean).join(" · ");
}

function taskFill(task, edges, taskById) {
  if (task.status === "Concluída") return "#d8eee0";
  if (task.status === "Em andamento") return "#f5c27d";
  if (task.status === "Cancelada") return "#e8aaa6";
  if (task.status === "Bloqueada") return "#b8bfbd";
  if (task.status !== "Não iniciada") return "#e8ecea";
  const taskNodeId = task.visualId || `task:${task.id}`;
  const predecessors = edges.filter((edge) => edge.target === taskNodeId && edge.source.startsWith("task:"));
  const ready = predecessors.every((edge) => {
    const status = taskById.get(edge.source)?.status;
    return status === "Concluída" || (!edge.blocking && status === "Em andamento");
  });
  return ready ? "#fbefc7" : "#e8ecea";
}

function priorityIcon(priority) {
  return ({ Crítica: "▲", Alta: "◆", Normal: "●", Baixa: "▽" })[priority] || "●";
}

function priorityColor(priority) {
  return ({ Crítica: "#c74c40", Alta: "#c77d28", Normal: "#537d8b", Baixa: "#668c78" })[priority] || "#537d8b";
}

function edgeLine(blocking) {
  return {
    stroke: blocking ? "#c83732" : "#b8c2bf",
    strokeWidth: blocking ? 3 : 1.5,
    strokeDasharray: blocking ? "" : "3 5",
    targetMarker: { name: "classic", size: 7 },
  };
}

function buildLayout(nodes, edges) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 42, ranksep: 100, marginx: 40, marginy: 45 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);
  return Object.fromEntries(nodes.map((node) => {
    const position = graph.node(node.id);
    return [node.id, { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 }];
  }));
}

export function createFlowchart(container, callbacks) {
  let currentEdges = [];
  let currentNodes = [];
  let isDrawing = false;
  let isOrganizing = false;
  let hasInitializedView = false;
  let removingEquivalentEdges = false;
  const statusMenu = document.createElement("div");
  statusMenu.className = "flow-status-menu hidden";
  statusMenu.setAttribute("role", "group");
  statusMenu.setAttribute("aria-label", "Alterar status da atividade");
  container.parentElement.append(statusMenu);

  function closeStatusMenu() {
    statusMenu.classList.add("hidden");
    statusMenu.replaceChildren();
  }

  function openStatusMenu(node, event) {
    const record = currentNodes.find((item) => item.id === node.id)?.record;
    if (node.getData()?.type !== "task" || !record) return;
    event.preventDefault();
    event.stopPropagation();
    statusMenu.replaceChildren(...TASK_STATUSES.map((status) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "flow-status-option";
      option.textContent = status;
      option.setAttribute("aria-pressed", String(record.status === status));
      option.addEventListener("click", () => {
        closeStatusMenu();
        callbacks.onTaskStatusChange(record.id, status);
      });
      return option;
    }));
    const bounds = container.parentElement.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 190));
    const top = Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 210));
    statusMenu.style.left = `${left}px`;
    statusMenu.style.top = `${top}px`;
    statusMenu.classList.remove("hidden");
    statusMenu.querySelector("button")?.focus();
  }

  document.addEventListener("pointerdown", (event) => {
    if (!statusMenu.contains(event.target)) closeStatusMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !statusMenu.classList.contains("hidden")) closeStatusMenu();
  });
  const graph = new Graph({
    container,
    async: false,
    width: container.clientWidth,
    height: container.clientHeight,
    background: { color: "#fbfcfa" },
    grid: { visible: true, type: "dot", args: { color: "#dce4df", thickness: 1 } },
    panning: { enabled: true },
    mousewheel: { enabled: true, modifiers: ["ctrl", "meta"], minScale: 0.45, maxScale: 1.8 },
    interacting: { nodeMovable: true, magnetConnectable: false },
    connecting: {
      allowBlank: false,
      allowLoop: false,
      allowMulti: true,
      snap: true,
      router: { name: "manhattan", args: { padding: 18 } },
      connector: { name: "rounded", args: { radius: 8 } },
      createEdge() {
        return this.createEdge({
          attrs: { line: edgeLine(true) },
          data: { blocking: true, userCreated: true },
        });
      },
      validateConnection({ sourceCell, targetCell }) {
        return Boolean(sourceCell && targetCell && sourceCell.id !== targetCell.id);
      },
    },
  });

  function persistEdges() {
    if (isDrawing) return;
    const originalCellId = (id) => {
      const node = currentNodes.find((item) => item.id === id);
      return node?.type === "task" ? `task:${node.record.recordId || node.record.id}` : id;
    };
    const uniqueEdges = new Map();
    for (const edge of graph.getEdges()) {
      const data = edge.getData() || {};
      if (data.relation === "phase-deliverable") continue;
      const source = data.originalSource || originalCellId(edge.getSourceCellId());
      const target = data.originalTarget || originalCellId(edge.getTargetCellId());
      if (!source || !target) continue;
      const key = `${source}:${target}:${data.relation || ""}`;
      uniqueEdges.set(key, { source, target, blocking: data.blocking !== false, userCreated: true, relation: data.relation });
    }
    currentEdges = graph.getEdges().map((edge) => ({
      source: edge.getSourceCellId(),
      target: edge.getTargetCellId(),
      blocking: edge.getData()?.blocking !== false,
      userCreated: true,
      relation: edge.getData()?.relation,
    })).filter((edge) => edge.source && edge.target);
    const taskById = new Map(currentNodes.filter((node) => node.type === "task").map((node) => [node.id, node.record]));
    for (const node of currentNodes.filter((item) => item.type === "task")) {
      graph.getCellById(node.id)?.attr("body/fill", taskFill(node.record, currentEdges, taskById));
    }
    callbacks.onEdgesChange([...uniqueEdges.values()]);
  }

  function persistPositions() {
    if (isOrganizing) return;
    const positions = Object.fromEntries(graph.getNodes().map((node) => [node.id, node.getPosition()]));
    callbacks.onPositionsChange(positions);
  }

  function fitToContent() {
    graph.resize(container.parentElement.clientWidth, container.parentElement.clientHeight);
    graph.zoomToFit({ padding: 40, maxScale: 0.85 });
    graph.centerContent();
  }

  function addGraphNode(node, position) {
    if (node.type === "phase") {
      const phaseDone = Boolean(node.record.completedAt);
      const phaseLabel = node.record.name.toLocaleUpperCase("pt-BR") + (phaseDone ? ` · ✓ CONCLUÍDA EM ${node.record.completedAt.split("-").reverse().join("/")}` : "");
      graph.addNode({
        id: node.id,
        shape: "rect",
        x: position.x,
        y: position.y,
        width: node.record.bandWidth,
        height: node.record.bandHeight,
        zIndex: 0,
        attrs: {
          body: { fill: phaseDone ? "#e6f2e8" : "#f5f8f5", stroke: phaseDone ? "#7fb48a" : "#d8e2dc", strokeWidth: 1, rx: 6, ry: 6, pointerEvents: "none" },
          label: { text: phaseLabel, refX: 14, refY: 10, textAnchor: "start", textVerticalAnchor: "top", fontSize: 10, fontWeight: 700, fill: phaseDone ? "#3d7a4a" : "#6e8175", pointerEvents: "none" },
          action: { text: phaseDone ? "↺ Reabrir fase" : "✓ Concluir fase", refX: node.record.bandWidth - 14, refY: 10, textAnchor: "end", textVerticalAnchor: "top", fontSize: 10, fontWeight: 700, fill: "#2784f5", cursor: "pointer", event: "node:phasecomplete" },
        },
        markup: [{ tagName: "rect", selector: "body" }, { tagName: "text", selector: "label" }, { tagName: "text", selector: "action" }],
        data: { type: "phase", recordId: node.record.id, projectId: node.record.projectId, phaseName: node.record.name },
      });
      return;
    }
    const isProject = node.type === "project";
    const isDeliverable = node.type === "deliverable";
    const isCompleted = isDeliverable && Boolean(node.record.completed);
    const fill = isProject ? "#cfe4e8" : isDeliverable ? (isCompleted ? "#cfe9d4" : "#d9e8e9") : taskFill(node.record, currentEdges, new Map(currentNodes.filter((item) => item.type === "task").map((item) => [item.id, item.record])));
    const priority = node.record.priority || "Normal";
    const assignee = initials(node.record.people || []);
    const externalTeams = (node.record.teamNames || []).map((name) => name.length > 12 ? `${name.slice(0, 11)}…` : name);
    const isExternal = !isProject && !isDeliverable && node.record.executionType === "external";
    const teamLabel = externalTeams.length > 1 ? `${externalTeams[0]} +${externalTeams.length - 1}` : externalTeams[0];
    const sharedEdgeCount = currentEdges.filter((edge) => edge.source === node.id && edge.target.startsWith("deliverable:")).length;
    const isShared = !isDeliverable && ((node.record.projectLinks || []).length > 0 || sharedEdgeCount > 1 || (node.record.sharedDeliverableIds || []).length > 0);
    const due = isProject ? "INÍCIO DO PLANO" : isDeliverable ? (isCompleted ? `✓ CONCLUÍDO ${(node.record.completedAt || "").split("-").reverse().join("/")}` : "ENTREGÁVEL") : (node.record.end ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${node.record.end}T12:00:00`)).replace(" de ", "/").replace(".", "") : "Sem data");
    const title = wrapNodeTitle(node.record.name);
    const meta = isProject ? "PROJETO" : isDeliverable ? "ALVO DE ENTREGA" : isExternal ? `TIME · ${teamLabel || "Sem atribuição"}   ◆ ${priority}` : `${assignee ? `♙ ${assignee}` : "♙ Sem responsável"}   ◆ ${priority}${isShared ? " · COMPARTILHADO" : ""}`;
    graph.addNode({
      id: node.id,
      shape: "rect",
      x: position.x,
      y: position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      zIndex: isProject ? 4 : isDeliverable ? 3 : 2,
      attrs: {
        body: { x: 0, y: 0, width: NODE_WIDTH, height: BLOCK_HEIGHT, fill, stroke: isProject ? "#17677a" : isDeliverable ? "#3e737d" : "#6e8881", strokeWidth: isProject ? 2 : 1.4, rx: 7, ry: 7, magnet: false, cursor: "move" },
        label: { text: title, refX: 14, refY: 12, textAnchor: "start", textVerticalAnchor: "top", fontSize: 12, fontWeight: 700, lineHeight: "16px", fill: "#23342f", textWrap: { width: NODE_WIDTH - 28, height: 36, ellipsis: true } },
        teamIndicator: { text: isExternal ? "↗" : "", refX: 14, refY: 55, textAnchor: "start", textVerticalAnchor: "top", fontSize: 10, fontWeight: 700, fill: "#17677a" },
        meta: { text: meta, refX: isExternal ? 28 : 14, refY: 55, textAnchor: "start", textVerticalAnchor: "top", fontSize: 9, fill: "#52645e", textWrap: { width: NODE_WIDTH - (isExternal ? 42 : 28), height: 18, ellipsis: true } },
        priority: { text: isProject || isDeliverable ? "" : priorityIcon(priority), refX: NODE_WIDTH - 23, refY: 54, textAnchor: "middle", textVerticalAnchor: "top", fontSize: 11, fontWeight: 700, fill: priorityColor(priority) },
        date: { text: due, refX: NODE_WIDTH / 2, refY: 94, textAnchor: "middle", textVerticalAnchor: "top", fontSize: 10, fontWeight: 650, fill: isProject || isDeliverable ? "#336671" : "#596a62" },
      },
      markup: [
        { tagName: "rect", selector: "body" },
        { tagName: "text", selector: "label" },
        { tagName: "text", selector: "teamIndicator" },
        { tagName: "text", selector: "meta" },
        { tagName: "text", selector: "priority" },
        { tagName: "text", selector: "date" },
      ],
      data: { type: node.type, recordId: node.record.recordId || node.record.id, visualId: node.id },
    });
    const graphNode = graph.getCellById(node.id);
    const addDirections = [{ direction: isDeliverable ? "left" : "right", x: isDeliverable ? 0 : NODE_WIDTH, y: BLOCK_HEIGHT / 2, offset: { x: isDeliverable ? -13 : 13, y: 0 }, path: "M -4 0 H 4 M 0 -4 V 4" }];
    const nodeTools = addDirections.map(({ direction, x, y, offset, path }) => ({
      name: "button",
      args: {
        x,
        y,
        offset,
        markup: [
          { tagName: "circle", selector: "button", attrs: { r: 11, fill: "#fff", stroke: "#2784f5", strokeWidth: 1.6, cursor: "pointer" } },
          { tagName: "path", selector: "icon", attrs: { d: path, fill: "none", stroke: "#2784f5", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", pointerEvents: "none" } },
        ],
        onClick: ({ cell }) => {
          persistPositions();
          const record = cell.getData();
          const sourceId = record.type === "task" ? `task:${record.recordId}` : cell.id;
          callbacks.onAddBlock(sourceId, direction, cell.getPosition(), record.phase);
        },
      },
    }));
    if (node.type === "task" || node.type === "deliverable") {
      nodeTools.push({
        name: "button",
        args: {
          x: NODE_WIDTH,
          y: 0,
          offset: { x: 13, y: -7 },
          markup: [
            { tagName: "circle", selector: "button", attrs: { r: 8, fill: "#fff", stroke: "#b65b50", strokeWidth: 1.4, cursor: "pointer" } },
            { tagName: "path", selector: "icon", attrs: { d: "M -3 -3 L 3 3 M -3 3 L 3 -3", fill: "none", stroke: "#b65b50", strokeWidth: 1.4, strokeLinecap: "round", pointerEvents: "none" } },
          ],
          onClick: ({ cell }) => node.type === "task"
            ? callbacks.onTaskDelete(cell.getData().recordId)
            : callbacks.onDeliverableDelete(cell.getData().recordId),
        },
      });
    }
    if (node.type === "deliverable") {
      nodeTools.push({
        name: "button",
        args: {
          x: NODE_WIDTH,
          y: BLOCK_HEIGHT,
          offset: { x: 13, y: 7 },
          markup: [
            { tagName: "circle", selector: "button", attrs: { r: 8, fill: "#fff", stroke: "#3d7a4a", strokeWidth: 1.4, cursor: "pointer" } },
            { tagName: "path", selector: "icon", attrs: { d: isCompleted ? "M -3 1 A 3.5 3.5 0 1 0 -2 -2 M -4 -3 V -1 H -2" : "M -4 0 L -1 3 L 4 -3", fill: "none", stroke: "#3d7a4a", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", pointerEvents: "none" } },
          ],
          onClick: ({ cell }) => callbacks.onDeliverableComplete(cell.getData().recordId),
        },
      });
    }
    graphNode.addTools(nodeTools);
    graph.findView(graphNode)?.hideTools();
  }

  function draw(data) {
    currentEdges = data.edges || [];
    currentNodes = data.nodes || [];
    isDrawing = true;
    const visibleCanvas = container.parentElement;
    graph.resize(visibleCanvas.clientWidth, visibleCanvas.clientHeight);
    graph.clearCells();
    const positions = {};
    const phaseNodes = currentNodes.filter((node) => node.type === "phase").sort((first, second) => first.record.phaseIndex - second.record.phaseIndex);
    const projectNode = currentNodes.find((node) => node.type === "project");
    const laneStartX = NODE_WIDTH + 140;
    const bandWidth = Math.max(1100, visibleCanvas.clientWidth / 0.85);
    let laneTop = 50;
    for (const phaseNode of phaseNodes) {
      const phaseIndex = phaseNode.record.phaseIndex;
      const laneDeliverables = currentNodes.filter((node) => node.type === "deliverable" && node.record.phaseIndex === phaseIndex);
      let pathTop = laneTop + 38;
      let laneHeight = 120;
      let lastColumn = 0;
      const pathDeliverables = laneDeliverables.length ? laneDeliverables : [null];
      for (const deliverableNode of pathDeliverables) {
        const pathDeliverableId = deliverableNode?.record.id;
        const laneTasks = currentNodes.filter((node) => node.type === "task"
          && node.record.phaseIndex === phaseIndex
          && node.record.pathDeliverableId === pathDeliverableId);
        const incomingCount = new Map(laneTasks.map((node) => [node.id, 0]));
        const outgoing = new Map(laneTasks.map((node) => [node.id, []]));
        for (const edge of currentEdges) {
          if (incomingCount.has(edge.source) && incomingCount.has(edge.target)) {
            outgoing.get(edge.source).push(edge.target);
            incomingCount.set(edge.target, incomingCount.get(edge.target) + 1);
          }
        }
        const ranks = new Map(laneTasks.map((node) => [node.id, 0]));
        const queue = laneTasks.filter((node) => incomingCount.get(node.id) === 0).map((node) => node.id);
        while (queue.length) {
          const source = queue.shift();
          for (const target of outgoing.get(source)) {
            ranks.set(target, Math.max(ranks.get(target), ranks.get(source) + 1));
            incomingCount.set(target, incomingCount.get(target) - 1);
            if (incomingCount.get(target) === 0) queue.push(target);
          }
        }
        const highestTaskRank = laneTasks.length ? Math.max(...ranks.values()) : -1;
        const columns = new Map();
        for (const taskNode of laneTasks) {
          const rank = ranks.get(taskNode.id) || 0;
          if (!columns.has(rank)) columns.set(rank, []);
          columns.get(rank).push(taskNode);
        }
        if (deliverableNode) columns.set(highestTaskRank + 1, [deliverableNode]);
        const pathMaxRows = Math.max(1, ...[...columns.values()].map((columnNodes) => columnNodes.length));
        const pathHeight = Math.max(NODE_HEIGHT + 34, pathMaxRows * (NODE_HEIGHT + 35) + 12);
        for (const [rank, columnNodes] of columns) {
          lastColumn = Math.max(lastColumn, rank);
          columnNodes.sort((first, second) => first.record.name.localeCompare(second.record.name, "pt-BR"));
          columnNodes.forEach((node, row) => {
            const fallback = { x: laneStartX + 16 + Math.max(0, rank) * (NODE_WIDTH + 90), y: pathTop + row * (NODE_HEIGHT + 35) };
            const stored = data.positions?.[node.id];
            positions[node.id] = stored || fallback;
          });
        }
        pathTop += pathHeight + 10;
        laneHeight += pathHeight + 10;
      }
      const bandHeight = Math.max(150, laneHeight + 12);
      phaseNode.record.bandWidth = Math.max(bandWidth, 40 + lastColumn * (NODE_WIDTH + 90) + NODE_WIDTH + 80);
      phaseNode.record.bandHeight = bandHeight;
      positions[phaseNode.id] = { x: laneStartX - 24, y: laneTop };
      laneTop += bandHeight + 20;
    }
    if (projectNode) {
      const laneSetHeight = phaseNodes.length ? laneTop - 20 : visibleCanvas.clientHeight;
      positions[projectNode.id] = { x: 40, y: Math.max(40, (laneSetHeight - NODE_HEIGHT) / 2) };
    }
    const automaticPositions = buildLayout(currentNodes.filter((node) => node.type !== "phase"), currentEdges.filter((edge) => edge.relation !== "phase-deliverable"));
    for (const node of currentNodes) {
      if (positions[node.id] || data.positions?.[node.id]) continue;
      positions[node.id] = automaticPositions[node.id] || { x: 40, y: 40 };
    }
    for (const node of currentNodes) addGraphNode(node, positions[node.id]);
    const projectTaskEdges = currentEdges.filter((edge) => edge.source === projectNode?.id && edge.target.startsWith("task:") && positions[edge.target]);
    const projectRight = projectNode && positions[projectNode.id] ? positions[projectNode.id].x + NODE_WIDTH : 0;
    const firstTaskLeft = Math.min(...projectTaskEdges.map((edge) => positions[edge.target].x));
    const projectTrunkX = projectTaskEdges.length
      ? Math.max(projectRight + 16, Math.min(projectRight + 38, firstTaskLeft - 32))
      : null;
    for (const edge of currentEdges) {
      if (!currentNodes.some((node) => node.id === edge.source) || !currentNodes.some((node) => node.id === edge.target)) continue;
      const isProjectTaskEdge = edge.source === projectNode?.id && edge.target.startsWith("task:") && projectTrunkX !== null;
      const vertices = isProjectTaskEdge ? [
        { x: projectTrunkX, y: positions[edge.source].y + BLOCK_HEIGHT / 2 },
        { x: projectTrunkX, y: positions[edge.target].y + BLOCK_HEIGHT / 2 },
        { x: positions[edge.target].x - 24, y: positions[edge.target].y + BLOCK_HEIGHT / 2 },
      ] : undefined;
      graph.addEdge({
        zIndex: 1,
        source: { cell: edge.source, port: "out" },
        target: { cell: edge.target, port: "in" },
        vertices,
        router: { name: "manhattan", args: { padding: 18 } },
        connector: { name: "rounded", args: { radius: 8 } },
        attrs: { line: edgeLine(edge.blocking !== false) },
        data: { blocking: edge.blocking, userCreated: edge.userCreated === true, relation: edge.relation, originalSource: edge.originalSource, originalTarget: edge.originalTarget },
      });
    }
    isDrawing = false;
    if (!hasInitializedView && currentNodes.length) {
      graph.zoomToFit({ padding: 40, maxScale: 0.85 });
      graph.centerContent();
      hasInitializedView = true;
    }
  }

  graph.on("edge:connected", ({ edge }) => {
    const source = edge.getSourceCellId();
    const target = edge.getTargetCellId();
    const blocking = source?.startsWith("task:") && target?.startsWith("task:");
    const sourceNode = currentNodes.find((node) => node.id === source);
    const targetNode = currentNodes.find((node) => node.id === target);
    edge.setData({
      blocking: Boolean(blocking),
      userCreated: true,
      originalSource: sourceNode?.type === "task" ? `task:${sourceNode.record.recordId || sourceNode.record.id}` : source,
      originalTarget: targetNode?.type === "task" ? `task:${targetNode.record.recordId || targetNode.record.id}` : target,
    });
    edge.attr("line", edgeLine(Boolean(blocking)));
    edge.setLabels([]);
    persistEdges();
  });

  graph.on("view:render", ({ view }) => {
    if (view.isNodeView()) view.hideTools();
  });
  graph.on("node:contextmenu", ({ e, node }) => openStatusMenu(node, e));
  graph.on("node:phasecomplete", ({ node }) => {
    const data = node.getData();
    callbacks.onPhaseComplete(data.projectId, data.phaseName);
  });
  graph.on("node:click", ({ node }) => {
    closeStatusMenu();
    if (node.getData()?.type === "phase") return;
    for (const cell of graph.getNodes()) {
      graph.findView(cell)?.hideTools();
      cell.attr("body/stroke", cell.getData()?.type === "deliverable" ? "#3e737d" : "#6e8881");
      cell.attr("body/strokeWidth", 1.4);
    }
    node.attr("body/stroke", "#2784f5");
    node.attr("body/strokeWidth", 2);
    graph.findView(node)?.showTools();
  });
  graph.on("blank:click", () => {
    closeStatusMenu();
    for (const cell of graph.getNodes()) {
      graph.findView(cell)?.hideTools();
      cell.attr("body/stroke", cell.getData()?.type === "deliverable" ? "#3e737d" : "#6e8881");
      cell.attr("body/strokeWidth", 1.4);
    }
  });

  graph.on("edge:click", ({ edge }) => {
    if (!edge.getSourceCellId()?.startsWith("task:") || !edge.getTargetCellId()?.startsWith("task:")) return;
    const blocking = edge.getData()?.blocking !== false;
    const data = edge.getData() || {};
    const source = data.originalSource || edge.getSourceCellId();
    const target = data.originalTarget || edge.getTargetCellId();
    for (const visualEdge of graph.getEdges()) {
      const visualData = visualEdge.getData() || {};
      if ((visualData.originalSource || visualEdge.getSourceCellId()) !== source || (visualData.originalTarget || visualEdge.getTargetCellId()) !== target) continue;
      visualEdge.setData({ ...visualData, blocking: !blocking, userCreated: true });
      visualEdge.attr("line", edgeLine(!blocking));
      visualEdge.setLabels([]);
    }
    persistEdges();
  });

  graph.on("edge:removed", ({ edge }) => {
    if (isDrawing || removingEquivalentEdges) return;
    const data = edge.getData() || {};
    const source = data.originalSource || edge.getSourceCellId();
    const target = data.originalTarget || edge.getTargetCellId();
    removingEquivalentEdges = true;
    for (const other of graph.getEdges()) {
      const otherData = other.getData() || {};
      if ((otherData.originalSource || other.getSourceCellId()) === source && (otherData.originalTarget || other.getTargetCellId()) === target) graph.removeCell(other);
    }
    removingEquivalentEdges = false;
    persistEdges();
  });
  graph.on("node:change:position", persistPositions);
  graph.on("node:dblclick", ({ node }) => {
    const data = node.getData();
    if (data.type === "task") callbacks.onTaskEdit(data.recordId);
    if (data.type === "deliverable") callbacks.onDeliverableEdit(data.recordId);
  });

  const observer = new ResizeObserver(() => graph.resize(container.parentElement.clientWidth, container.parentElement.clientHeight));
  observer.observe(container.parentElement);

  return {
    draw,
    getPositions() {
      return Object.fromEntries(graph.getNodes().map((node) => [node.id, node.getPosition()]));
    },
    autoLayout(onlyDeliverableIds = null, fitView = true) {
      if (currentNodes.some((node) => node.type === "phase")) {
        const positions = onlyDeliverableIds?.length ? this.getPositions() : {};
        if (onlyDeliverableIds?.length) {
          const targets = new Set(onlyDeliverableIds);
          for (const node of currentNodes) {
            if (node.type === "deliverable" && targets.has(node.record.id)) delete positions[node.id];
            if (node.type === "task" && targets.has(node.record.pathDeliverableId)) delete positions[node.id];
          }
        }
        draw({ nodes: currentNodes, edges: currentEdges, positions });
        if (fitView) fitToContent();
        persistPositions();
        return;
      }
      const nodes = graph.getNodes().map((node) => ({ node, position: node.getPosition() }));
      if (!nodes.length) return;
      const columnWidth = NODE_WIDTH + 90;
      const rowHeight = NODE_HEIGHT + 35;
      const nodeById = new Map(nodes.map((item) => [item.node.id, item]));
      const incomingCount = new Map(nodes.map(({ node }) => [node.id, 0]));
      const outgoing = new Map(nodes.map(({ node }) => [node.id, []]));
      for (const edge of currentEdges) {
        if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
        outgoing.get(edge.source).push(edge.target);
        incomingCount.set(edge.target, incomingCount.get(edge.target) + 1);
      }
      const hasProject = nodes.some(({ node }) => node.getData()?.type === "project");
      const ranks = new Map(nodes.map(({ node }) => {
        const type = node.getData()?.type;
        return [node.id, type === "project" ? 0 : type === "task" && hasProject ? 1 : 0];
      }));
      const ready = nodes.filter(({ node }) => incomingCount.get(node.id) === 0).map(({ node }) => node.id);
      let visited = 0;
      while (ready.length) {
        const source = ready.shift();
        visited += 1;
        for (const target of outgoing.get(source)) {
          ranks.set(target, Math.max(ranks.get(target), ranks.get(source) + 1));
          incomingCount.set(target, incomingCount.get(target) - 1);
          if (incomingCount.get(target) === 0) ready.push(target);
        }
      }
      if (visited !== nodes.length) {
        for (const { node, position } of nodes) ranks.set(node.id, Math.max(ranks.get(node.id), Math.round(position.x / columnWidth)));
      }
      const taskRanks = nodes.filter(({ node }) => node.getData()?.type === "task").map(({ node }) => ranks.get(node.id));
      const deliverableRank = taskRanks.length ? Math.max(...taskRanks) + 1 : (hasProject ? 1 : 0);
      for (const { node } of nodes) {
        if (node.getData()?.type === "deliverable") ranks.set(node.id, Math.max(ranks.get(node.id), deliverableRank));
      }
      const columns = new Map();
      for (const item of nodes) {
        item.column = ranks.get(item.node.id);
        if (!columns.has(item.column)) columns.set(item.column, []);
        columns.get(item.column).push(item);
      }
      isOrganizing = true;
      for (const [column, items] of columns) {
        items.sort((first, second) => first.position.y - second.position.y || first.position.x - second.position.x);
        items.forEach(({ node }, row) => node.position(40 + column * columnWidth, 40 + row * rowHeight));
      }
      isOrganizing = false;
      persistPositions();
      if (fitView) fitToContent();
    },
    resetView() {
      fitToContent();
    },
  };
}
