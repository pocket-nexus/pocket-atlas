import { PLACES, localTime } from "../places/registry";
import type { PlaceDef } from "../core/types";
import { QUALITY_LEVELS, type QualityLevel } from "../core/quality";

type Handler<T = void> = (value: T) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  html = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GlobeHandlers {
  onHover: Handler<string | null>;
  onSelect: Handler<string>;
}

export interface PlaceHandlers {
  onBack: Handler;
  onCinematic: Handler;
  onShot: Handler<string>;
}

/**
 * All DOM chrome over the canvas: globe picker, loading screen, place HUD and
 * the shared system controls. Stages drive it; it never touches WebGL.
 */
export class Overlay {
  readonly root: HTMLElement;
  private fade = el("div", "pc-fade");
  private globe = el("section", "pc-globe-ui");
  private cards = new Map<string, HTMLElement>();
  private tooltip = el("div", "pc-tooltip");
  private loading = el("section", "pc-loading");
  private loadBar = el("div", "pc-loading-bar-fill");
  private loadLabel = el("div", "pc-loading-label");
  private loadPct = el("div", "pc-loading-pct");
  private hud = el("section", "pc-hud");
  private system = el("div", "pc-system");
  private toastEl = el("div", "pc-toast");
  private statsEl = el("div", "pc-stats");
  private clockTimer = 0;
  private toastTimer = 0;
  private globeHandlers: GlobeHandlers | null = null;
  private placeHandlers: PlaceHandlers | null = null;
  private hudClock: HTMLElement | null = null;
  private hudPlace: PlaceDef | null = null;
  private muteBtn = el("button", "pc-chip");
  private qualityBtn = el("button", "pc-chip");
  private hidden = false;

  onToggleMute: Handler = () => {};
  onQuality: Handler<QualityLevel> = () => {};

  constructor(root: HTMLElement, capture: boolean) {
    this.root = root;
    root.classList.toggle("pc-capture", capture);
    root.append(this.globe, this.tooltip, this.hud, this.loading, this.system, this.toastEl, this.statsEl, this.fade);
    this.buildGlobe();
    this.buildLoading();
    this.buildSystem();
    this.clockTimer = window.setInterval(() => this.tickClocks(), 1000 * 15);
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "h" || e.key === "H") this.toggleHidden();
    });
  }

  // ---------------------------------------------------------------- globe

  private buildGlobe(): void {
    const brand = el(
      "header",
      "pc-brand",
      `<div class="pc-brand-mark"><span></span></div>
       <div>
         <h1>Pocket&nbsp;Atlas</h1>
         <p>Pick a place on the night side of the planet. Step inside.</p>
       </div>`,
    );
    const list = el("nav", "pc-place-list");
    const head = el("div", "pc-place-list-head", `<span>Places</span><span>${PLACES.filter((c) => c.status === "live").length} / ${PLACES.length} open</span>`);
    list.append(head);
    const scroller = el("div", "pc-place-scroll");
    const ordered = [...PLACES].sort((a, b) => Number(b.status === "live") - Number(a.status === "live"));
    for (const place of ordered) {
      const card = el("button", `pc-card ${place.status === "live" ? "is-live" : "is-soon"}`);
      card.style.setProperty("--accent", place.accent);
      card.innerHTML = `
        <div class="pc-card-row">
          <span class="pc-card-name">${place.locality}</span>
          <span class="pc-card-native">${place.localityNative}</span>
          <span class="pc-card-time" data-clock="${place.id}">${localTime(place)}</span>
        </div>
        <div class="pc-card-scene">${place.name}</div>
        <div class="pc-card-meta">
          <span class="pc-dot"></span>
          <span>${place.status === "live" ? "Open now · enter" : "Under construction"}</span>
          <span class="pc-card-weather">${place.weather}</span>
        </div>`;
      card.addEventListener("pointerenter", () => this.globeHandlers?.onHover(place.id));
      card.addEventListener("pointerleave", () => this.globeHandlers?.onHover(null));
      card.addEventListener("click", () => this.globeHandlers?.onSelect(place.id));
      this.cards.set(place.id, card);
      scroller.append(card);
    }
    list.append(scroller);
    const hint = el("footer", "pc-hint", `<span><kbd>Drag</kbd> spin</span><span><kbd>Scroll</kbd> zoom</span><span><kbd>Click</kbd> a beacon</span>`);
    this.globe.append(brand, list, hint);
  }

  showGlobe(handlers: GlobeHandlers): void {
    this.globeHandlers = handlers;
    this.globe.classList.add("is-visible");
    this.tickClocks();
  }

  hideGlobe(): void {
    this.globeHandlers = null;
    this.globe.classList.remove("is-visible");
    this.hideTooltip();
  }

  setHovered(id: string | null): void {
    for (const [cid, card] of this.cards) card.classList.toggle("is-hover", cid === id);
    if (id) this.cards.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  showTooltip(place: PlaceDef, x: number, y: number): void {
    const t = this.tooltip;
    if (t.dataset.place !== place.id) {
      t.dataset.place = place.id;
      t.style.setProperty("--accent", place.accent);
      t.innerHTML = `
        <div class="pc-tt-top"><b>${place.locality}</b><span>${place.localityNative}</span></div>
        <div class="pc-tt-scene">${place.name}<i>${place.native}</i></div>
        <div class="pc-tt-meta"><span>${localTime(place)} local</span><span>${place.weather}</span></div>
        <div class="pc-tt-cta">${place.status === "live" ? "Click to enter ↵" : "Coming soon"}</div>`;
    }
    t.style.transform = `translate3d(${Math.round(x + 18)}px, ${Math.round(y - 12)}px, 0)`;
    t.classList.add("is-visible");
  }

  hideTooltip(): void {
    this.tooltip.classList.remove("is-visible");
    delete this.tooltip.dataset.place;
  }

  // -------------------------------------------------------------- loading

  private buildLoading(): void {
    const bar = el("div", "pc-loading-bar");
    bar.append(this.loadBar);
    const foot = el("div", "pc-loading-foot");
    foot.append(this.loadLabel, this.loadPct);
    this.loading.append(el("div", "pc-loading-native"), el("div", "pc-loading-title"), el("div", "pc-loading-sub"), bar, foot);
  }

  showLoading(place: PlaceDef): void {
    const [native, title, sub] = Array.from(this.loading.children) as HTMLElement[];
    native.textContent = place.localityNative;
    title.textContent = `${place.locality} — ${place.name}`;
    sub.textContent = place.native;
    this.loading.style.setProperty("--accent", place.accent);
    this.loadBar.style.transform = "scaleX(0)";
    this.loadLabel.textContent = "Preparing";
    this.loadPct.textContent = "0%";
    this.loading.classList.add("is-visible");
  }

  setLoading(fraction: number, label?: string): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.loadBar.style.transform = `scaleX(${f})`;
    this.loadPct.textContent = `${Math.round(f * 100)}%`;
    if (label) this.loadLabel.textContent = label;
  }

  async hideLoading(): Promise<void> {
    this.loading.classList.remove("is-visible");
    await wait(700);
  }

  // ------------------------------------------------------------------ HUD

  showPlace(place: PlaceDef, handlers: PlaceHandlers, shots: string[]): void {
    this.placeHandlers = handlers;
    this.hudPlace = place;
    this.hud.style.setProperty("--accent", place.accent);
    this.hud.innerHTML = `
      <button class="pc-back" type="button" aria-label="Back to globe"><span>←</span> Globe</button>
      <div class="pc-hud-loc">
        <div class="pc-hud-place"><b>${place.locality}</b><span>${place.localityNative}</span></div>
        <div class="pc-hud-scene">${place.name} · ${place.native}</div>
        <div class="pc-hud-meta"><span class="pc-hud-clock"></span><span>${place.weather}</span></div>
      </div>
      <div class="pc-hud-shots"></div>
      <footer class="pc-hint"><span><kbd>Drag</kbd> look</span><span><kbd>Scroll</kbd> dolly</span><span><kbd>C</kbd> cinematic</span><span><kbd>H</kbd> hide UI</span></footer>`;
    this.hud.querySelector(".pc-back")!.addEventListener("click", () => this.placeHandlers?.onBack());
    const shotsEl = this.hud.querySelector(".pc-hud-shots")!;
    const cine = el("button", "pc-chip is-accent", "Cinematic");
    cine.addEventListener("click", () => this.placeHandlers?.onCinematic());
    shotsEl.append(cine);
    for (const s of shots) {
      const b = el("button", "pc-chip", s);
      b.addEventListener("click", () => this.placeHandlers?.onShot(s));
      shotsEl.append(b);
    }
    this.hudClock = this.hud.querySelector(".pc-hud-clock");
    this.tickClocks();
    this.hud.classList.add("is-visible");
  }

  setCinematic(on: boolean): void {
    this.hud.querySelector(".pc-hud-shots .is-accent")?.classList.toggle("is-on", on);
  }

  hidePlace(): void {
    this.placeHandlers = null;
    this.hudPlace = null;
    this.hud.classList.remove("is-visible");
  }

  // ------------------------------------------------------------- system

  private buildSystem(): void {
    this.muteBtn.type = "button";
    this.qualityBtn.type = "button";
    this.muteBtn.addEventListener("click", () => this.onToggleMute());
    this.qualityBtn.addEventListener("click", () => {
      const cur = (this.qualityBtn.dataset.level ?? "high") as QualityLevel;
      const next = QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(cur) + 1) % QUALITY_LEVELS.length];
      this.onQuality(next);
    });
    this.system.append(this.qualityBtn, this.muteBtn);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.innerHTML = muted ? "Sound off" : "Sound on";
    this.muteBtn.classList.toggle("is-on", !muted);
  }

  setQuality(level: QualityLevel): void {
    this.qualityBtn.dataset.level = level;
    this.qualityBtn.textContent = `Quality · ${level}`;
  }

  // -------------------------------------------------------------- common

  async fadeTo(opacity: number, ms: number, color = "#000"): Promise<void> {
    this.fade.style.background = color;
    this.fade.style.transitionDuration = `${ms}ms`;
    // Force style flush so the transition starts from the current value.
    void this.fade.offsetWidth;
    this.fade.style.opacity = String(opacity);
    await wait(ms);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add("is-visible");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("is-visible"), 2400);
  }

  setStats(text: string | null): void {
    this.statsEl.textContent = text ?? "";
    this.statsEl.classList.toggle("is-visible", !!text);
  }

  private toggleHidden(): void {
    this.hidden = !this.hidden;
    this.root.classList.toggle("pc-hidden", this.hidden);
  }

  private tickClocks(): void {
    const now = new Date();
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-clock]")) {
      const place = PLACES.find((c) => c.id === node.dataset.clock);
      if (place) node.textContent = localTime(place, now);
    }
    if (this.hudClock && this.hudPlace) this.hudClock.textContent = `${localTime(this.hudPlace, now)} local`;
  }

  dispose(): void {
    clearInterval(this.clockTimer);
  }
}
