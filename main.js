const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, setIcon } = require("obsidian");

const PLUGIN_ID = "inksync";
const TOOL_PENCIL = "pencil";
const TOOL_ERASER = "eraser";
const DEFAULT_SETTINGS = {
  color: "#e53935",
  width: 4,
  opacity: 0.72,
  eraserWidth: 18,
  savedColors: ["#e53935", "#111827"],
  drawings: {}
};

module.exports = class InkSyncPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.controllers = new Map();
    this.refresh = this.refresh.bind(this);

    this.addSettingTab(new InkSyncSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("layout-change", this.refresh));
    this.registerEvent(this.app.workspace.on("active-leaf-change", this.refresh));
    this.registerEvent(this.app.workspace.on("file-open", this.refresh));
    this.registerInterval(window.setInterval(this.refresh, 1200));
    this.refresh();
  }

  onunload() {
    for (const controller of this.controllers.values()) controller.destroy();
    this.controllers.clear();
  }

  refresh() {
    const markdownViews = this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof MarkdownView);
    const live = new Set();
    for (const view of markdownViews) {
      if (!view.file) continue;
      const contentEl = view.contentEl?.querySelector(".view-content") || view.containerEl?.querySelector(".view-content");
      if (!contentEl) continue;
      live.add(contentEl);
      if (!this.controllers.has(contentEl)) {
        this.controllers.set(contentEl, new InkSyncController(this, view, contentEl));
      } else {
        this.controllers.get(contentEl).setView(view);
      }
    }
    for (const [contentEl, controller] of this.controllers.entries()) {
      if (!live.has(contentEl) || !contentEl.isConnected) {
        controller.destroy();
        this.controllers.delete(contentEl);
      }
    }
  }

  getFileKey(file) {
    return file?.path || "";
  }

  getDrawingData(file) {
    const key = this.getFileKey(file);
    if (!key) return { strokes: [] };
    const data = this.settings.drawings[key];
    return data && Array.isArray(data.strokes) ? data : { strokes: [] };
  }

  async setDrawingData(file, data) {
    const key = this.getFileKey(file);
    if (!key) return;
    this.settings.drawings[key] = {
      version: 1,
      updatedAt: new Date().toISOString(),
      strokes: Array.isArray(data.strokes) ? data.strokes : []
    };
    await this.saveData(this.settings);
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    for (const controller of this.controllers.values()) controller.applySettings();
  }
};

class InkSyncController {
  constructor(plugin, view, contentEl) {
    this.plugin = plugin;
    this.view = view;
    this.contentEl = contentEl;
    this.tool = TOOL_PENCIL;
    this.active = false;
    this.drawing = false;
    this.currentStroke = null;
    this.saveTimer = null;
    this.lastRenderedFile = "";

    this.host = document.createElement("div");
    this.host.className = "inksync-basic-host";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "inksync-basic-toolbar";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "inksync-basic-canvas";
    this.ctx = this.canvas.getContext("2d");

    this.host.append(this.toolbar, this.canvas);
    this.contentEl.appendChild(this.host);
    this.contentEl.classList.add("has-inksync-basic");
    this.buildToolbar();

    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundResize = this.resize.bind(this);
    this.boundScroll = this.render.bind(this);

    this.canvas.addEventListener("pointerdown", this.boundPointerDown);
    window.addEventListener("pointermove", this.boundPointerMove, { passive: false });
    window.addEventListener("pointerup", this.boundPointerUp);
    window.addEventListener("resize", this.boundResize);
    this.contentEl.addEventListener("scroll", this.boundScroll, { passive: true });

    this.resize();
    this.render();
  }

  setView(view) {
    this.view = view;
    const key = this.plugin.getFileKey(view.file);
    if (key !== this.lastRenderedFile) this.render();
  }

  buildToolbar() {
    this.toggleButton = this.button("pencil", "InkSync", () => {
      this.active = !this.active;
      this.applySettings();
    });
    this.pencilButton = this.button("pencil", "铅笔", () => {
      this.tool = TOOL_PENCIL;
      this.active = true;
      this.applySettings();
    });
    this.eraserButton = this.button("eraser", "橡皮擦", () => {
      this.tool = TOOL_ERASER;
      this.active = true;
      this.applySettings();
    });
    this.colorButtons = this.plugin.settings.savedColors.slice(0, 2).map((color, index) => {
      const button = this.button("circle", `颜色 ${index + 1}`, async () => {
        this.plugin.settings.color = color;
        await this.plugin.saveSettings();
      });
      button.classList.add("inksync-basic-swatch");
      button.style.setProperty("--inksync-basic-color", color);
      return button;
    });
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.className = "inksync-basic-color-input";
    this.colorInput.title = "调色";
    this.colorInput.value = this.plugin.settings.color;
    this.colorInput.addEventListener("input", async () => {
      this.plugin.settings.color = this.colorInput.value;
      this.plugin.settings.savedColors = [this.colorInput.value, this.plugin.settings.savedColors[1] || "#111827"];
      await this.plugin.saveSettings();
    });
    this.toolbar.appendChild(this.colorInput);
    this.applySettings();
  }

  button(icon, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inksync-basic-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    this.toolbar.appendChild(button);
    return button;
  }

  applySettings() {
    const settings = this.plugin.settings;
    this.host.classList.toggle("is-active", this.active);
    this.host.classList.toggle("is-pencil", this.tool === TOOL_PENCIL);
    this.host.classList.toggle("is-eraser", this.tool === TOOL_ERASER);
    this.toggleButton?.classList.toggle("is-active", this.active);
    this.pencilButton?.classList.toggle("is-active", this.active && this.tool === TOOL_PENCIL);
    this.eraserButton?.classList.toggle("is-active", this.active && this.tool === TOOL_ERASER);
    if (this.colorInput) this.colorInput.value = settings.color;
    this.colorButtons?.forEach((button, index) => {
      const color = settings.savedColors[index] || settings.color;
      button.style.setProperty("--inksync-basic-color", color);
      button.classList.toggle("is-active", color === settings.color);
    });
    this.render();
  }

  resize() {
    const rect = this.contentEl.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.style.width = `${Math.max(1, rect.width)}px`;
    this.canvas.style.height = `${Math.max(1, rect.height)}px`;
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.render();
  }

  onPointerDown(event) {
    if (!this.active || event.button !== 0) return;
    event.preventDefault();
    this.canvas.setPointerCapture?.(event.pointerId);
    const point = this.eventToPoint(event);
    if (!point) return;
    this.drawing = true;
    if (this.tool === TOOL_ERASER) {
      this.eraseAt(point);
      return;
    }
    const settings = this.plugin.settings;
    this.currentStroke = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: TOOL_PENCIL,
      color: settings.color,
      width: settings.width,
      opacity: settings.opacity,
      points: [point]
    };
    this.render([this.currentStroke]);
  }

  onPointerMove(event) {
    if (!this.drawing || !this.active) return;
    event.preventDefault();
    const point = this.eventToPoint(event);
    if (!point) return;
    if (this.tool === TOOL_ERASER) {
      this.eraseAt(point);
      return;
    }
    if (!this.currentStroke) return;
    this.currentStroke.points.push(point);
    this.render([this.currentStroke]);
  }

  async onPointerUp() {
    if (!this.drawing) return;
    this.drawing = false;
    if (this.currentStroke && this.currentStroke.points.length > 1) {
      const data = this.plugin.getDrawingData(this.view.file);
      data.strokes.push(this.currentStroke);
      this.currentStroke = null;
      await this.plugin.setDrawingData(this.view.file, data);
    }
    this.currentStroke = null;
    this.render();
  }

  eventToPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + this.contentEl.scrollLeft,
      y: event.clientY - rect.top + this.contentEl.scrollTop
    };
  }

  async eraseAt(point) {
    const data = this.plugin.getDrawingData(this.view.file);
    const threshold = this.plugin.settings.eraserWidth;
    const before = data.strokes.length;
    data.strokes = data.strokes.filter((stroke) => !stroke.points?.some((strokePoint) => distance(point, strokePoint) <= threshold));
    if (data.strokes.length !== before) {
      await this.plugin.setDrawingData(this.view.file, data);
      this.render();
    }
  }

  render(extraStrokes = []) {
    if (!this.ctx) return;
    this.lastRenderedFile = this.plugin.getFileKey(this.view.file);
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, width, height);
    const data = this.plugin.getDrawingData(this.view.file);
    for (const stroke of [...data.strokes, ...extraStrokes]) this.drawStroke(stroke);
  }

  drawStroke(stroke) {
    if (!stroke?.points?.length) return;
    const points = stroke.points;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = clamp(Number(stroke.opacity) || DEFAULT_SETTINGS.opacity, 0.05, 1);
    ctx.strokeStyle = stroke.color || DEFAULT_SETTINGS.color;
    ctx.lineWidth = clamp(Number(stroke.width) || DEFAULT_SETTINGS.width, 1, 40);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x - this.contentEl.scrollLeft, points[0].y - this.contentEl.scrollTop);
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i];
      ctx.lineTo(point.x - this.contentEl.scrollLeft, point.y - this.contentEl.scrollTop);
    }
    ctx.stroke();
    ctx.restore();
  }

  destroy() {
    window.removeEventListener("pointermove", this.boundPointerMove);
    window.removeEventListener("pointerup", this.boundPointerUp);
    window.removeEventListener("resize", this.boundResize);
    this.contentEl.removeEventListener("scroll", this.boundScroll);
    this.host.remove();
    this.contentEl.classList.remove("has-inksync-basic");
  }
}

class InkSyncSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "InkSync" });
    new Setting(containerEl)
      .setName("铅笔粗细")
      .addSlider((slider) => slider
        .setLimits(1, 16, 1)
        .setValue(this.plugin.settings.width)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.width = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("铅笔透明度")
      .addSlider((slider) => slider
        .setLimits(20, 100, 1)
        .setValue(Math.round(this.plugin.settings.opacity * 100))
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.opacity = value / 100;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("橡皮擦大小")
      .addSlider((slider) => slider
        .setLimits(6, 48, 1)
        .setValue(this.plugin.settings.eraserWidth)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.eraserWidth = value;
          await this.plugin.saveSettings();
        }));
  }
}

function normalizeSettings(input) {
  const savedColors = Array.isArray(input?.savedColors) ? input.savedColors.filter(isColor).slice(0, 2) : [];
  while (savedColors.length < 2) savedColors.push(DEFAULT_SETTINGS.savedColors[savedColors.length]);
  return {
    color: isColor(input?.color) ? input.color : DEFAULT_SETTINGS.color,
    width: clamp(Number(input?.width) || DEFAULT_SETTINGS.width, 1, 16),
    opacity: clamp(Number(input?.opacity) || DEFAULT_SETTINGS.opacity, 0.2, 1),
    eraserWidth: clamp(Number(input?.eraserWidth) || DEFAULT_SETTINGS.eraserWidth, 6, 48),
    savedColors,
    drawings: input?.drawings && typeof input.drawings === "object" ? input.drawings : {}
  };
}

function isColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
