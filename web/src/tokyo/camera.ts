import { MathUtils, Vector3, type PerspectiveCamera } from "three";

export interface ShotKey {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface Shot {
  name: string;
  from: ShotKey;
  to: ShotKey;
  duration: number;
}

/** Walkable camera volumes: [minX, minY, minZ, maxX, maxY, maxZ]. */
type Box6 = [number, number, number, number, number, number];

const ease = (t: number) => t * t * (3 - 2 * t);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Three modes: an intro crane-down, a free orbit around a movable focus
 * (mouse/touch/keys), and a cinematic sequencer that plays authored shots
 * with dip-to-black cuts. Free mode drops back into cinematic after idling.
 */
export class CameraRig {
  mode: "intro" | "free" | "cinematic" = "free";
  readonly target = new Vector3();
  private camera: PerspectiveCamera;
  private dom: HTMLElement;
  private shots: Shot[];
  private boxes: Box6[];
  // Free-orbit state (smoothed toward goal).
  private yaw = 0;
  private pitch = 0.1;
  private dist = 10;
  private goalYaw = 0;
  private goalPitch = 0.1;
  private goalDist = 10;
  private goalTarget = new Vector3();
  private fov = 40;
  private goalFov = 40;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pinch = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private idle = 0;
  // Cinematic state.
  private shotIndex = 0;
  private shotTime = 0;
  private introTime = 0;
  private introFrom: ShotKey | null = null;
  private introTo: ShotKey | null = null;
  private introDuration = 7;
  /** 0..1 fade to black requested by the rig (applied in the grade pass). */
  fade = 0;
  autoCinematicAfter = 40;
  onModeChange: (mode: CameraRig["mode"]) => void = () => {};
  private cleanup: (() => void)[] = [];

  constructor(camera: PerspectiveCamera, dom: HTMLElement, shots: Shot[], boxes: Box6[]) {
    this.camera = camera;
    this.dom = dom;
    this.shots = shots;
    this.boxes = boxes;
    this.bind();
  }

  private bind(): void {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on(this.dom, "pointerdown", (e) => {
      this.dom.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.interact();
    });
    on(this.dom, "pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch > 0) this.goalDist = MathUtils.clamp(this.goalDist * (this.pinch / d), 1.5, 28);
        this.pinch = d;
        return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const k = 0.0042;
      this.goalYaw -= dx * k;
      this.goalPitch = MathUtils.clamp(this.goalPitch + dy * k, -0.35, 1.25);
      this.interact();
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = 0;
      if (this.pointers.size === 0) this.dragging = false;
    };
    on(this.dom, "pointerup", up);
    on(this.dom, "pointercancel", up);
    on(
      this.dom,
      "wheel",
      (e) => {
        e.preventDefault();
        this.goalDist = MathUtils.clamp(this.goalDist * Math.exp(e.deltaY * 0.0012), 1.5, 28);
        this.interact();
      },
      { passive: false },
    );
    on(window, "keydown", (e) => {
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        this.keys.add(k);
        this.interact();
      }
    });
    on(window, "keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    on(window, "blur", () => this.keys.clear());
  }

  private interact(): void {
    this.idle = 0;
    if (this.mode !== "free") this.enterFree();
  }

  /** Continue from wherever the camera is now, as a free orbit. */
  enterFree(): void {
    const pos = this.camera.position;
    // Derive orbit parameters from the current view.
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    const d = this.mode === "cinematic" || this.mode === "intro" ? Math.max(3, Math.min(14, this.dist)) : this.dist;
    this.target.copy(pos).addScaledVector(dir, d);
    this.goalTarget.copy(this.target);
    this.setOrbitFrom(pos, this.target);
    this.fade = 0;
    this.setMode("free");
  }

  private setOrbitFrom(pos: Vector3, target: Vector3): void {
    const off = new Vector3().subVectors(pos, target);
    this.dist = this.goalDist = off.length();
    this.yaw = this.goalYaw = Math.atan2(off.x, off.z);
    this.pitch = this.goalPitch = Math.asin(MathUtils.clamp(off.y / this.dist, -1, 1));
  }

  private setMode(m: CameraRig["mode"]): void {
    if (this.mode === m) return;
    this.mode = m;
    this.onModeChange(m);
  }

  /** Jump to a named shot's end framing in free mode. */
  goTo(name: string): void {
    const s = this.shots.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (s) this.goToKey(s.to);
  }

  goToKey(k: ShotKey): void {
    this.setMode("free");
    this.idle = 0;
    this.fade = 0;
    this.applyKey(k);
    this.target.set(...k.target);
    this.goalTarget.copy(this.target);
    this.setOrbitFrom(this.camera.position, this.target);
    this.fov = this.goalFov = k.fov;
  }

  startCinematic(from = 0): void {
    this.shotIndex = from % this.shots.length;
    this.shotTime = 0;
    this.setMode("cinematic");
  }

  toggleCinematic(): void {
    if (this.mode === "cinematic") this.enterFree();
    else this.startCinematic(this.shotIndex);
  }

  startIntro(from: ShotKey, to: ShotKey, duration: number): void {
    this.introFrom = from;
    this.introTo = to;
    this.introDuration = duration;
    this.introTime = 0;
    this.setMode("intro");
    this.applyKey(from);
  }

  private applyKey(k: ShotKey): void {
    this.camera.position.set(...k.pos);
    this.camera.lookAt(k.target[0], k.target[1], k.target[2]);
    this.camera.fov = k.fov;
    this.camera.updateProjectionMatrix();
  }

  private lerpKey(a: ShotKey, b: ShotKey, t: number): { pos: Vector3; target: Vector3; fov: number } {
    const pos = new Vector3(...a.pos).lerp(new Vector3(...b.pos), t);
    const target = new Vector3(...a.target).lerp(new Vector3(...b.target), t);
    return { pos, target, fov: MathUtils.lerp(a.fov, b.fov, t) };
  }

  /** Distance from the camera to what it looks at (drives depth of field). */
  focusDistance(): number {
    return this.camera.position.distanceTo(this.target);
  }

  update(dt: number, time: number): void {
    if (this.mode === "intro" && this.introFrom && this.introTo) {
      this.introTime += dt;
      const t = Math.min(1, this.introTime / this.introDuration);
      const e = easeInOutCubic(t);
      const k = this.lerpKey(this.introFrom, this.introTo, e);
      // Crane arc: drift toward the middle of the street while descending.
      k.pos.x -= Math.sin(e * Math.PI) * 0.8;
      this.camera.position.copy(k.pos);
      this.camera.lookAt(k.target);
      this.camera.fov = k.fov;
      this.camera.updateProjectionMatrix();
      this.target.copy(k.target);
      this.dist = k.pos.distanceTo(k.target);
      if (t >= 1) this.enterFree();
      return;
    }

    if (this.mode === "cinematic") {
      const s = this.shots[this.shotIndex];
      this.shotTime += dt;
      const t = Math.min(1, this.shotTime / s.duration);
      const k = this.lerpKey(s.from, s.to, ease(t));
      // Gentle handheld drift.
      k.pos.x += Math.sin(time * 0.53) * 0.025;
      k.pos.y += Math.sin(time * 0.71 + 1.3) * 0.018;
      this.camera.position.copy(k.pos);
      this.camera.lookAt(k.target);
      this.camera.fov = k.fov;
      this.camera.updateProjectionMatrix();
      this.target.copy(k.target);
      this.dist = k.pos.distanceTo(k.target);
      const fadeLen = 0.7;
      const out = Math.max(0, (this.shotTime - (s.duration - fadeLen)) / fadeLen);
      const inn = Math.max(0, 1 - this.shotTime / fadeLen);
      this.fade = Math.min(1, Math.max(out, inn));
      if (this.shotTime >= s.duration) {
        this.shotIndex = (this.shotIndex + 1) % this.shots.length;
        this.shotTime = 0;
      }
      return;
    }

    // ---- free orbit
    this.idle += dt;
    if (this.idle > this.autoCinematicAfter) {
      this.startCinematic(this.shotIndex);
      return;
    }
    const move = new Vector3();
    const fwd = new Vector3(-Math.sin(this.goalYaw), 0, -Math.cos(this.goalYaw));
    const right = new Vector3(-fwd.z, 0, fwd.x);
    if (this.keys.has("w") || this.keys.has("arrowup")) move.add(fwd);
    if (this.keys.has("s") || this.keys.has("arrowdown")) move.sub(fwd);
    if (this.keys.has("d") || this.keys.has("arrowright")) move.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) move.sub(right);
    if (this.keys.has("e")) move.y += 1;
    if (this.keys.has("q")) move.y -= 1;
    if (move.lengthSq() > 0) this.goalTarget.addScaledVector(move.normalize(), dt * 4.5);
    this.goalTarget.x = MathUtils.clamp(this.goalTarget.x, -40, 40);
    this.goalTarget.y = MathUtils.clamp(this.goalTarget.y, 0.4, 8);
    this.goalTarget.z = MathUtils.clamp(this.goalTarget.z, -40, 30);

    const k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.dist += (this.goalDist - this.dist) * k;
    this.fov += (this.goalFov - this.fov) * k;
    this.target.lerp(this.goalTarget, k);
    const cp = Math.cos(this.pitch);
    const desired = new Vector3(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.position.copy(this.constrain(desired));
    this.camera.lookAt(this.target);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Keeps the camera inside the street volumes (never inside buildings). */
  private constrain(p: Vector3): Vector3 {
    let best: Vector3 | null = null;
    let bestD = Infinity;
    for (const b of this.boxes) {
      const q = new Vector3(MathUtils.clamp(p.x, b[0], b[3]), MathUtils.clamp(p.y, b[1], b[4]), MathUtils.clamp(p.z, b[2], b[5]));
      const d = q.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
      if (d === 0) break;
    }
    return best ?? p;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.cleanup = [];
  }
}
