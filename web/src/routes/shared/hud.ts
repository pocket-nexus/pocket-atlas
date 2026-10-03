import type { Stop } from "./drive/trip";

/**
 * The driving display over the canvas: speed, the next stop and the
 * distance to it, the trip's progress along the route with its stops, the
 * local time of the drive and short notices. Plain DOM, styled in
 * `styles.css` (`.rt-*`).
 */
export class RouteHud {
  private root = document.createElement("section");
  private speed = document.createElement("div");
  private next = document.createElement("div");
  private bar = document.createElement("div");
  private dot = document.createElement("i");
  private clock = document.createElement("div");
  private notice = document.createElement("div");
  private card = document.createElement("div");
  private noticeTimer = 0;

  constructor(
    parent: HTMLElement,
    private stops: readonly Stop[],
    private length: number,
    accent: string,
  ) {
    this.root.className = "rt-hud";
    this.root.style.setProperty("--accent", accent);
    this.speed.className = "rt-speed";
    this.next.className = "rt-next";
    this.bar.className = "rt-bar";
    this.clock.className = "rt-clock";
    this.notice.className = "rt-notice";
    this.card.className = "rt-card";
    for (const s of stops) {
      const tick = document.createElement("span");
      tick.style.left = `${(s.s / length) * 100}%`;
      tick.title = s.name;
      this.bar.append(tick);
    }
    this.dot.className = "rt-dot";
    this.bar.append(this.dot);
    const help = document.createElement("footer");
    help.className = "rt-help";
    help.innerHTML = `<span><kbd>W</kbd><kbd>S</kbd> drive, brake</span><span><kbd>A</kbd><kbd>D</kbd> steer</span><span><kbd>V</kbd> view</span><span><kbd>R</kbd> back to the last stop</span><span><kbd>C</kbd> look around</span>`;
    this.root.append(this.speed, this.next, this.bar, this.clock, this.notice, this.card, help);
    parent.append(this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle("is-visible", on);
  }

  update(kmh: number, s: number, stop: number, metres: number, clock: string, limit: number): void {
    this.speed.innerHTML = `<b>${Math.round(kmh)}</b><small>km/h</small>${limit ? `<em>${limit}</em>` : ""}`;
    const st = this.stops[stop];
    const km = metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;
    this.next.innerHTML = `<small>Next</small><b>${st.name}</b><span>${st.native}</span><em>${km}</em>`;
    this.dot.style.left = `${Math.min(100, (s / this.length) * 100)}%`;
    this.clock.textContent = clock;
  }

  /** A short line that fades after a few seconds. */
  say(html: string, seconds = 5): void {
    this.notice.innerHTML = html;
    this.notice.classList.add("is-on");
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.notice.classList.remove("is-on"), seconds * 1000);
  }

  /** A card in the middle of the screen (departure, arrival); empty hides it. */
  panel(html: string): void {
    this.card.innerHTML = html;
    this.card.classList.toggle("is-on", html !== "");
  }

  dispose(): void {
    clearTimeout(this.noticeTimer);
    this.root.remove();
  }
}
