import { Group, Vector3 } from "three";
import type { DayWorld } from "../shared/daylight/context";
import { quad } from "../shared/shapes";
import { source } from "../shared/provenance";
import { stand } from "../shared/people/motion";
import { Figure, type Build, type Look } from "../shared/people/rig";
import { thinFigure } from "../shared/people/thin";
import { Wear } from "../shared/people/wear";
import { LOOP } from "./layout";

export function buildLife(w: DayWorld) {
  const people = source("visitors/ordinary-waterfront-visitors", w.group()); people.userData.dynamic = true;
  const wear = new Wear(w.lib, false);
  const specs = [
    { p: [5, .15, -6], yaw: -.6, height: 1.73, fem: 0, top: 0x526775, skin: 0xbd967b },
    { p: [-54, .1, 2], yaw: -1.5, height: 1.64, fem: 1, top: 0xa16a51, skin: 0xa67757 },
    { p: [158, .1, -70], yaw: 2.5, height: 1.78, fem: 0, top: 0x8c9b91, skin: 0xd1ac8b },
  ];
  specs.forEach((s, i) => {
    const build: Build = { height: s.height, fem: s.fem, hair: s.fem ? "bob" : "short", top: { t: .018, hem: .70, cuff: .018 }, legs: { loose: .019 }, shoe: "sneaker", cast: false };
    const look: Look = { skin: { hex: s.skin, rough: .65 }, hair: { hex: 0x44382b, rough: .75 }, top: { hex: s.top, rough: .8 }, bottom: { hex: 0x4b5861, rough: .8 }, shoes: { hex: 0xd6d2c0, rough: .7 } };
    const f = new Figure(build, look, wear); thinFigure(f, .055); f.root.position.set(s.p[0], s.p[1], s.p[2]); f.root.rotation.y = s.yaw; f.root.name = `Visitor ${i + 1}`; people.add(f.root);
    const feet: [Vector3, Vector3] = [new Vector3(.1, .075 * f.d.s, .015), new Vector3(-.1, .075 * f.d.s, -.025)];
    w.update((_dt, t) => { const a = t / LOOP * Math.PI * 2; stand(f, { feet, toe: [.12, -.13], weight: .25 * Math.sin(a * 3 + i), lean: .015, twist: .035 * Math.sin(a * 4 + i), breath: a * 24 + i, yaw: .15 * Math.sin(a * 2 + i), pitch: .04 * Math.sin(a * 5) }); f.swing(0, .04, -.04, .24, .1); f.swing(1, -.03, -.05, .21, .08); });
  });
  for (let i = 0; i < 5; i++) {
    const bird = source(`bay/gull-${i}`, new Group()); bird.name = `Gull ${i + 1}`; bird.userData.dynamic = true; w.root.add(bird);
    const wings: Group[] = [];
    for (const side of [-1, 1]) {
      const wing = new Group(); bird.add(wing); wings.push(wing);
      const a = new Vector3(0, 0, -.24), b = new Vector3(side * .6, .025, -.04), c = new Vector3(side * .84, -.06, .2), d = new Vector3(0, 0, .18);
      w.mesh(quad(a, b, c, d, new Vector3(0, 1, 0)), w.lib.plain(0xd7d8cf), 0, 0, 0, wing, { cast: false });
      w.mesh(quad(d, c, b, a, new Vector3(0, -1, 0)), w.lib.plain(0xa6aaa3), 0, 0, 0, wing, { cast: false });
    }
    w.update((_dt, t) => { const a = t / LOOP * Math.PI * 2 + i; bird.position.set(-25 + Math.sin(a) * (34 + i * 7), 13 + i * 1.7 + Math.sin(a * 4), -85 + Math.cos(a) * 31); bird.rotation.y = -a; wings[0].rotation.z = Math.sin(a * 36) * .24; wings[1].rotation.z = -Math.sin(a * 36) * .24; });
  }
}
