const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, requestUrl, setIcon } = require("obsidian");

const PLUGIN_ID = "inksync-lite";
const PLUGIN_NAME = "InkSync Lite";
const FULL_PLUGIN_ID = "inksync";
const TOOL_DRAW = "draw";
const TOOL_ERASER = "eraser";
const UPGRADE_OWNER = "LittleFeng1603";
const UPGRADE_REPO = "InkSync";
const UPGRADE_REF = "main";
const UPGRADE_PATH = "";
const UPGRADE_TOKEN_PREFIX = "github_pat_11CCLGR6Q0r0Ti6Xy8kvI6_";
const DOWNLOAD_FILES = ["manifest.json", "main.js", "styles.css"];
const DEFAULT_SETTINGS = {
  color: "#e53935",
  width: 4,
  opacity: 0.72,
  eraserWidth: 18,
  savedColors: ["#e53935", "#111827"],
  upgradeKey: "",
  drawings: {}
};

module.exports = class InkSyncLitePlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.controllers = new Map();
    this.refresh = this.refresh.bind(this);
    this.addSettingTab(new InkSyncLiteSettingTab(this.app, this));
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
    const views = this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof MarkdownView);
    const live = new Set();
    for (const view of views) {
      if (!view.file) continue;
      const contentEl = view.contentEl?.querySelector(".view-content") || view.containerEl?.querySelector(".view-content");
      if (!contentEl) continue;
      live.add(contentEl);
      if (this.controllers.has(contentEl)) {
        this.controllers.get(contentEl).setView(view);
      } else {
        this.controllers.set(contentEl, new InkSyncLiteController(this, view, contentEl));
      }
    }
    for (const [contentEl, controller] of this.controllers.entries()) {
      if (!live.has(contentEl) || !contentEl.isConnected) {
        controller.destroy();
        this.controllers.delete(contentEl);
      }
    }
  }

  fileKey(file) {
    return file?.path || "";
  }

  drawingData(file) {
    const key = this.fileKey(file);
    const data = key ? this.settings.drawings[key] : null;
    return data && Array.isArray(data.strokes) ? data : { version: 1, strokes: [] };
  }

  async setDrawingData(file, data) {
    const key = this.fileKey(file);
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

  async upgradeToFullVersion() {
    const token = resolveUpgradeToken(this.settings.upgradeKey);
    if (!token) {
      new Notice("请输入升级密钥。");
      return;
    }
    try {
      const remoteManifest = await this.fetchUpgradeFile("manifest.json", token, true);
      if (remoteManifest.id !== FULL_PLUGIN_ID) {
        throw new Error("remote manifest id mismatch");
      }
      const adapter = this.app.vault.adapter;
      const configDir = this.app.vault.configDir || ".obsidian";
      const targetDir = `${configDir}/plugins/${FULL_PLUGIN_ID}`;
      if (!await adapter.exists(targetDir)) {
        await adapter.mkdir(targetDir);
      }
      const files = {};
      for (const fileName of DOWNLOAD_FILES) {
        files[fileName] = fileName === "manifest.json" ? JSON.stringify(remoteManifest, null, 2) : await this.fetchUpgradeFile(fileName, token, false);
      }
      if (!files["main.js"].includes("InkSync") || !files["manifest.json"].includes(FULL_PLUGIN_ID)) {
        throw new Error("downloaded files did not look like InkSync");
      }
      for (const fileName of DOWNLOAD_FILES) {
        await adapter.write(`${targetDir}/${fileName}`, files[fileName]);
      }
      new Notice(`已升级到 InkSync ${remoteManifest.version || ""}，请重启 Obsidian 后启用 InkSync。`, 10000);
    } catch (error) {
      console.error(`[${PLUGIN_ID}] Upgrade failed`, error);
      new Notice("升级失败，请检查密钥和网络。", 8000);
    }
  }

  async fetchUpgradeFile(fileName, token, asJson) {
    const path = [UPGRADE_PATH, fileName].filter(Boolean).join("/");
    const url = `https://api.github.com/repos/${UPGRADE_OWNER}/${UPGRADE_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(UPGRADE_REF)}`;
    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        Accept: "application/vnd.github.raw",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub ${response.status}`);
    }
    return asJson ? JSON.parse(response.text) : response.text;
  }
};

class InkSyncLiteController {
  constructor(plugin, view, contentEl) {
    this.plugin = plugin;
    this.view = view;
    this.contentEl = contentEl;
    this.active = false;
    this.toolMode = TOOL_DRAW;
    this.paletteOpen = false;
    this.drawing = false;
    this.currentStroke = null;
    this.lastFileKey = "";
    this.host = document.createElement("div");
    this.host.className = "inksync-shell is-inksync-controls-visible";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "inksync-toolbar is-drawing-active is-inksync-controls-visible";
    this.palettePanel = document.createElement("div");
    this.palettePanel.className = "inksync-palette-panel is-drawing-active is-inksync-controls-visible";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "inksync-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.host.append(this.toolbar, this.palettePanel, this.canvas);
    this.contentEl.appendChild(this.host);
    this.contentEl.classList.add("has-inksync-lite");
    this.installHeaderButton();
    this.buildToolbar();
    this.buildPalette();
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.resize = this.resize.bind(this);
    this.render = this.render.bind(this);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("resize", this.resize);
    this.contentEl.addEventListener("scroll", this.render, { passive: true });
    this.resize();
    this.render();
  }

  setView(view) {
    this.view = view;
    const key = this.plugin.fileKey(view.file);
    if (key !== this.lastFileKey) this.render();
  }

  buildToolbar() {
    this.drawButton = this.createButton("pencil", "铅笔", () => {
      this.active = true;
      this.toolMode = TOOL_DRAW;
      this.applySettings();
    });
    this.eraserButton = this.createButton("eraser", "橡皮擦", () => {
      this.active = true;
      this.toolMode = TOOL_ERASER;
      this.applySettings();
    });
    this.paletteButton = this.createButton("palette", "颜色", () => {
      this.active = true;
      this.paletteOpen = !this.paletteOpen;
      this.applySettings();
    });
    this.drawButton.classList.add("inksync-brush-button");
  }

  installHeaderButton() {
    this.view?.containerEl?.querySelectorAll(".inksync-lite-header-button").forEach((button) => button.remove());
    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.active = !this.active;
      if (!this.active) this.paletteOpen = false;
      this.applySettings();
    };
    if (typeof this.view?.addAction === "function") {
      this.headerButton = this.view.addAction("wand-sparkles", "InkSync Lite", onClick);
    }
    if (!this.headerButton) {
      const actions = this.view?.containerEl?.querySelector(".view-actions");
      this.headerButton = document.createElement("div");
      this.headerButton.className = "clickable-icon view-action";
      this.headerButton.setAttribute("aria-label", "InkSync Lite");
      this.headerButton.setAttribute("title", "InkSync Lite");
      setIcon(this.headerButton, "wand-sparkles");
      this.headerButton.addEventListener("click", onClick);
      if (actions) actions.appendChild(this.headerButton);
    }
    this.headerButton?.classList.add("inksync-lite-header-button", "inksync-header-button");
  }

  buildPalette() {
    this.colorGrid = document.createElement("div");
    this.colorGrid.className = "inksync-color-grid";
    this.palettePanel.appendChild(this.colorGrid);
    this.colorButtons = [];
    for (let index = 0; index < 2; index += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inksync-color-swatch";
      button.title = `颜色 ${index + 1}`;
      button.addEventListener("click", async () => {
        const color = this.plugin.settings.savedColors[index];
        if (!color) return;
        this.plugin.settings.color = color;
        await this.plugin.saveSettings();
      });
      this.colorGrid.appendChild(button);
      this.colorButtons.push(button);
    }
    this.advancedColorButton = document.createElement("button");
    this.advancedColorButton.type = "button";
    this.advancedColorButton.className = "inksync-color-advanced";
    this.advancedColorButton.title = "调色";
    setIcon(this.advancedColorButton, "sliders-horizontal");
    this.colorInput = document.createElement("input");
    this.colorInput.className = "inksync-advanced-color";
    this.colorInput.type = "color";
    this.colorInput.addEventListener("input", async () => {
      this.plugin.settings.color = this.colorInput.value;
      this.plugin.settings.savedColors = [this.colorInput.value, this.plugin.settings.savedColors[1] || "#111827"].slice(0, 2);
      await this.plugin.saveSettings();
    });
    this.advancedColorButton.addEventListener("click", () => this.colorInput.click());
    this.colorGrid.appendChild(this.advancedColorButton);
    this.palettePanel.appendChild(this.colorInput);
    this.widthInput = this.createRangeRow("circle", "铅笔粗细", 1, 16, 0.5, this.plugin.settings.width, async (value) => {
      this.plugin.settings.width = value;
      await this.plugin.saveSettings();
    });
    this.opacityInput = this.createRangeRow("droplets", "透明度", 0.2, 1, 0.02, this.plugin.settings.opacity, async (value) => {
      this.plugin.settings.opacity = value;
      await this.plugin.saveSettings();
    });
    const previewRow = document.createElement("div");
    previewRow.className = "inksync-palette-row inksync-brush-preview-row";
    const previewIcon = document.createElement("span");
    previewIcon.className = "inksync-palette-icon inksync-brush-preview-icon";
    setIcon(previewIcon, "pencil");
    const track = document.createElement("span");
    track.className = "inksync-brush-preview-track";
    this.previewStroke = document.createElement("span");
    this.previewStroke.className = "inksync-brush-preview-stroke";
    track.appendChild(this.previewStroke);
    previewRow.append(previewIcon, track);
    this.palettePanel.appendChild(previewRow);
  }

  createButton(icon, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    this.toolbar.appendChild(button);
    return button;
  }

  createRangeRow(icon, title, min, max, step, value, onInput) {
    const row = document.createElement("div");
    row.className = "inksync-palette-row";
    const iconEl = document.createElement("span");
    iconEl.className = "inksync-palette-icon";
    setIcon(iconEl, icon);
    const input = document.createElement("input");
    input.type = "range";
    input.title = title;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("input", () => onInput(Number(input.value)));
    row.append(iconEl, input);
    this.palettePanel.appendChild(row);
    return input;
  }

  applySettings() {
    const settings = this.plugin.settings;
    this.host.classList.toggle("is-drawing-active", this.active);
    this.host.classList.toggle("is-palette-open", this.paletteOpen);
    this.host.classList.toggle("is-eraser-mode", this.toolMode === TOOL_ERASER);
    this.headerButton?.classList.toggle("is-active", this.active);
    this.drawButton.classList.toggle("is-active", this.active && this.toolMode === TOOL_DRAW);
    this.drawButton.classList.toggle("is-brush-color-active", this.active && this.toolMode === TOOL_DRAW);
    this.eraserButton.classList.toggle("is-active", this.active && this.toolMode === TOOL_ERASER);
    this.paletteButton.classList.toggle("is-active", this.paletteOpen);
    setProps(this.drawButton, {
      "--inksync-brush-button-color": settings.color,
      "--inksync-brush-button-contrast": contrastTextColor(settings.color)
    });
    this.colorInput.value = settings.color;
    this.widthInput.value = String(settings.width);
    this.opacityInput.value = String(settings.opacity);
    this.colorButtons.forEach((button, index) => {
      const color = settings.savedColors[index] || settings.color;
      setProps(button, { "--inksync-swatch-color": color });
      button.classList.toggle("is-active", color.toLowerCase() === settings.color.toLowerCase());
    });
    setProps(this.previewStroke, {
      "--inksync-brush-preview-color": settings.color,
      "--inksync-brush-preview-opacity": settings.opacity,
      "--inksync-brush-preview-width": `${Math.max(2, settings.width)}px`
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
    this.positionControls();
    this.render();
  }

  positionControls() {
    setProps(this.toolbar, {
      "--inksync-toolbar-top": "48px",
      "--inksync-toolbar-right": "8px"
    });
    setProps(this.palettePanel, {
      "--inksync-palette-top": "92px",
      "--inksync-palette-right": "8px"
    });
  }

  onPointerDown(event) {
    if (!this.active || event.button !== 0) return;
    event.preventDefault();
    const point = this.eventPoint(event);
    if (this.toolMode === TOOL_ERASER) {
      this.eraseAt(point);
      return;
    }
    const settings = this.plugin.settings;
    this.drawing = true;
    this.currentStroke = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      color: settings.color,
      width: settings.width,
      opacity: settings.opacity,
      points: [point]
    };
    this.render([this.currentStroke]);
  }

  onPointerMove(event) {
    if (!this.drawing || !this.active || !this.currentStroke) return;
    event.preventDefault();
    this.currentStroke.points.push(this.eventPoint(event));
    this.render([this.currentStroke]);
  }

  async onPointerUp() {
    if (!this.drawing) return;
    this.drawing = false;
    if (this.currentStroke?.points?.length > 1) {
      const data = this.plugin.drawingData(this.view.file);
      data.strokes.push(this.currentStroke);
      await this.plugin.setDrawingData(this.view.file, data);
    }
    this.currentStroke = null;
    this.render();
  }

  eventPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + this.contentEl.scrollLeft,
      y: event.clientY - rect.top + this.contentEl.scrollTop
    };
  }

  async eraseAt(point) {
    const data = this.plugin.drawingData(this.view.file);
    const before = data.strokes.length;
    data.strokes = data.strokes.filter((stroke) => !stroke.points?.some((item) => distance(point, item) <= this.plugin.settings.eraserWidth));
    if (data.strokes.length !== before) {
      await this.plugin.setDrawingData(this.view.file, data);
      this.render();
    }
  }

  render(extra = []) {
    if (!this.ctx) return;
    this.lastFileKey = this.plugin.fileKey(this.view.file);
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    this.ctx.clearRect(0, 0, width, height);
    const strokes = this.plugin.drawingData(this.view.file).strokes.concat(extra);
    for (const stroke of strokes) this.drawStroke(stroke);
  }

  drawStroke(stroke) {
    const points = stroke?.points || [];
    if (!points.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = clamp(Number(stroke.opacity) || DEFAULT_SETTINGS.opacity, 0.2, 1);
    ctx.strokeStyle = isColor(stroke.color) ? stroke.color : DEFAULT_SETTINGS.color;
    ctx.lineWidth = clamp(Number(stroke.width) || DEFAULT_SETTINGS.width, 1, 16);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x - this.contentEl.scrollLeft, points[0].y - this.contentEl.scrollTop);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      ctx.lineTo(point.x - this.contentEl.scrollLeft, point.y - this.contentEl.scrollTop);
    }
    ctx.stroke();
    ctx.restore();
  }

  destroy() {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("resize", this.resize);
    this.contentEl.removeEventListener("scroll", this.render);
    this.headerButton?.remove();
    this.host.remove();
    this.contentEl.classList.remove("has-inksync-lite");
  }
}

class InkSyncLiteSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "InkSync Lite 1.0.0" });
    new Setting(containerEl)
      .setName("当前版本")
      .setDesc("InkSync Lite 1.0.0");
    new Setting(containerEl)
      .setName("更新入口")
      .setDesc("输入升级密钥后可下载完整版 InkSync，解锁笔记跟随、四种笔刷、PDF 绘图、自动布局基准、文字/选择工具和更多绘图增强。")
      .addText((text) => text
        .setPlaceholder("升级密钥")
        .setValue(this.plugin.settings.upgradeKey)
        .onChange(async (value) => {
          this.plugin.settings.upgradeKey = value.trim();
          await this.plugin.saveSettings();
        }))
      .addButton((button) => button
        .setButtonText("升级")
        .setCta()
        .onClick(() => this.plugin.upgradeToFullVersion()));
    new Setting(containerEl)
      .setName("购买链接")
      .setDesc("https://pay.ldxp.cn/item/f5zaya")
      .addButton((button) => button
        .setButtonText("打开")
        .onClick(() => window.open("https://pay.ldxp.cn/item/f5zaya")));
    new Setting(containerEl)
      .setName("铅笔粗细")
      .addSlider((slider) => slider
        .setLimits(1, 16, 0.5)
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
    upgradeKey: String(input?.upgradeKey || ""),
    drawings: input?.drawings && typeof input.drawings === "object" ? input.drawings : {}
  };
}

function resolveUpgradeToken(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("github_pat_") ? trimmed : `${UPGRADE_TOKEN_PREFIX}${trimmed}`;
}

function encodePath(path) {
  return String(path || "").split("/").map(encodeURIComponent).join("/");
}

function setProps(element, props) {
  for (const [key, value] of Object.entries(props)) {
    element?.style?.setProperty(key, String(value));
  }
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

function contrastTextColor(color) {
  if (!isColor(color)) return "#fff";
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111827" : "#fff";
}
