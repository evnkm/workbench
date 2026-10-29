import type { Connection, Person } from "@workbench/contracts";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { useTheme } from "../lib/theme.ts";

export const personColor = (person: Person) => {
  const seed = (person.tags[0] ?? person.name).split("").reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return ["#5fb3a1", "#6f9fd8", "#d6a058", "#d98b8b", "#9aae7f"][seed % 5]!;
};
export type GraphActions = { zoom: (scale: number) => void; fit: () => void; focus: (id: string) => void };
type Node = {
  person: Person;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  label: THREE.Sprite;
  /** Rendered name width in CSS pixels, for label collision. */
  labelWidth: number;
  degree: number;
  velocity: THREE.Vector3;
};

export function RolodexGraph({
  people,
  connections,
  selected,
  onSelect,
  actions,
}: {
  people: Person[];
  connections: Connection[];
  selected: string | null;
  onSelect: (id: string) => void;
  actions: RefObject<GraphActions | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  const selectRef = useRef(onSelect);
  selectedRef.current = selected;
  selectRef.current = onSelect;
  const graph = useRef<{
    scene: THREE.Scene;
    group: THREE.Group;
    nodes: Map<string, Node>;
    edges: { connection: Connection; line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> }[];
    heat: number;
    autoFit: boolean;
  } | null>(null);
  const [error, setError] = useState(false);
  // Canvas labels and lines cannot use CSS variables; re-read the theme's ramp when it changes.
  useTheme();
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--color-neutral-200").trim();
  const edgeColor = css.getPropertyValue("--color-neutral-500").trim();
  const font = css.getPropertyValue("--font-sans").trim();
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    element.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D relationship graph. Drag to orbit, scroll to zoom, select a person to open their card.",
    );
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#444444", 2));
    const light = new THREE.DirectionalLight("#ffffff", 2.4);
    light.position.set(100, 120, 180);
    scene.add(light);
    const group = new THREE.Group();
    scene.add(group);
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 10000);
    camera.position.set(25, 50, 280);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 35;
    controls.maxDistance = 5000;
    controls.autoRotateSpeed = 0.18;
    const state = {
      scene,
      group,
      nodes: new Map<string, Node>(),
      edges: [] as NonNullable<typeof graph.current>["edges"],
      heat: 0,
      autoFit: true,
    };
    graph.current = state;
    controls.addEventListener("start", () => {
      state.autoFit = false;
    });
    const observer = new ResizeObserver(() => {
      camera.aspect = element.clientWidth / Math.max(element.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
      if (state.autoFit) actions.current?.fit();
    });
    observer.observe(element);
    actions.current = {
      zoom: (scale) => {
        state.autoFit = false;
        camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
      },
      fit: () => {
        if (!state.nodes.size) return;
        state.autoFit = true;
        const sphere = new THREE.Sphere().setFromPoints([...state.nodes.values()].map((n) => n.mesh.position));
        const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
        const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
        const distance = Math.max(120, ((sphere.radius + 16) / Math.sin(angle)) * 1.05);
        const direction = camera.position.clone().sub(controls.target).normalize();
        controls.target.copy(sphere.center);
        camera.position.copy(sphere.center).addScaledVector(direction, distance);
      },
      focus: (id) => {
        state.autoFit = false;
        const node = state.nodes.get(id);
        if (node) {
          controls.target.copy(node.mesh.position);
          camera.position.copy(node.mesh.position).add(new THREE.Vector3(15, 20, 125));
        }
      },
    };
    const raycaster = new THREE.Raycaster();
    let down = { x: 0, y: 0 };
    const pointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const pointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const box = element.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1),
        camera,
      );
      const hit = raycaster.intersectObjects(
        [...state.nodes.values()].flatMap((n) => (n.label.visible ? [n.mesh, n.label] : [n.mesh])),
      )[0];
      if (hit) selectRef.current(String(hit.object.userData.id));
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (document.visibilityState !== "visible") return;
      const nodes = [...state.nodes.values()];
      if (state.heat > 0) {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]!;
          for (let j = i + 1; j < nodes.length; j++) {
            const other = nodes[j]!;
            const delta = node.mesh.position.clone().sub(other.mesh.position);
            const force = delta.multiplyScalar(65 / Math.max(delta.lengthSq(), 80));
            node.velocity.add(force);
            other.velocity.sub(force);
          }
          node.velocity.addScaledVector(node.mesh.position, -0.002);
        }
        for (const { connection } of state.edges) {
          const a = state.nodes.get(connection.from),
            b = state.nodes.get(connection.to);
          if (!a || !b) continue;
          const delta = b.mesh.position.clone().sub(a.mesh.position);
          const length = delta.length();
          delta.multiplyScalar(((length - 65) * 0.003) / Math.max(length, 1));
          a.velocity.add(delta);
          b.velocity.sub(delta);
        }
        for (const n of nodes) {
          n.velocity.multiplyScalar(0.8);
          n.mesh.position.add(n.velocity);
        }
        if (state.autoFit && state.heat % 6 === 0) actions.current?.fit();
        state.heat--;
      }
      const selectedId = selectedRef.current;
      const neighbors = new Set(
        state.edges
          .filter((e) => e.connection.from === selectedId || e.connection.to === selectedId)
          .flatMap((e) => [e.connection.from, e.connection.to]),
      );
      const width = element.clientWidth;
      const height = element.clientHeight;
      const placed: [number, number, number, number][] = [];
      const priority = (n: Node) =>
        n.person.id === selectedId ? 1e6 : neighbors.has(n.person.id) ? 1e5 + n.degree : n.degree;
      for (const node of nodes) {
        const depth = Math.max(1, -node.mesh.position.clone().applyMatrix4(camera.matrixWorldInverse).z);
        const worldPerPixel =
          (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(element.clientHeight, 1);
        const scale = Math.max(1, (worldPerPixel * 6) / 4.2) * (node.person.id === selectedId ? 1.55 : 1);
        node.mesh.scale.setScalar(scale);
        node.label.scale.set(200 * worldPerPixel, 20 * worldPerPixel, 1);
        node.label.position.copy(node.mesh.position).add(new THREE.Vector3(0, -(4.2 * scale + worldPerPixel * 14), 0));
        node.mesh.material.opacity =
          !selectedId || neighbors.has(node.person.id) || node.person.id === selectedId ? 1 : 0.25;
      }
      // Hide labels that would overlap a more important one; zooming in reveals them.
      for (const node of nodes.sort((a, b) => priority(b) - priority(a))) {
        const p = node.label.position.clone().project(camera);
        const x = ((p.x + 1) / 2) * width;
        const y = ((1 - p.y) / 2) * height;
        const box: [number, number, number, number] = [
          x - node.labelWidth / 2 - 4,
          x + node.labelWidth / 2 + 4,
          y - 9,
          y + 9,
        ];
        const fits = p.z < 1 && !placed.some((b) => box[0] < b[1] && box[1] > b[0] && box[2] < b[3] && box[3] > b[2]);
        if (fits) placed.push(box);
        const target = fits ? node.mesh.material.opacity : 0;
        const material = node.label.material;
        material.opacity += (target - material.opacity) * 0.25;
        node.label.visible = material.opacity > 0.02;
      }
      for (const { connection, line } of state.edges) {
        const a = state.nodes.get(connection.from),
          b = state.nodes.get(connection.to);
        if (!a || !b) continue;
        const position = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        position.setXYZ(0, a.mesh.position.x, a.mesh.position.y, a.mesh.position.z);
        position.setXYZ(1, b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
        position.needsUpdate = true;
        line.geometry.computeBoundingSphere();
        line.material.opacity = !selectedId
          ? 0.3
          : neighbors.has(connection.from) && neighbors.has(connection.to)
            ? 0.8
            : 0.06;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      disposeGroup(group);
      renderer.dispose();
      renderer.forceContextLoss();
      element.replaceChildren();
      graph.current = null;
      actions.current = null;
    };
  }, [actions]);
  useEffect(() => {
    const state = graph.current;
    if (!state) return;
    const positions = new Map([...state.nodes].map(([id, n]) => [id, n.mesh.position.clone()]));
    disposeGroup(state.group);
    state.nodes.clear();
    state.edges = [];
    for (const [index, person] of people.entries()) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(4.2, 20, 14),
        new THREE.MeshStandardMaterial({
          color: personColor(person),
          emissive: personColor(person),
          emissiveIntensity: 0.12,
          roughness: 0.45,
          metalness: 0.08,
          transparent: true,
        }),
      );
      mesh.userData.id = person.id;
      mesh.position.copy(
        positions.get(person.id) ??
          new THREE.Vector3(
            Math.cos(index * 2.4) * (35 + index * 3),
            Math.sin(index * 1.8) * 45,
            Math.sin(index * 2.4) * 55,
          ),
      );
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 51;
      const ctx = canvas.getContext("2d")!;
      ctx.font = `500 30px ${font}`;
      ctx.fillStyle = ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const name = person.name.slice(0, 34);
      ctx.fillText(name, 256, 26);
      const texture = new THREE.CanvasTexture(canvas);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
      label.userData.id = person.id;
      label.scale.set(70, 11, 1);
      state.group.add(mesh, label);
      state.nodes.set(person.id, {
        person,
        mesh,
        label,
        labelWidth: (ctx.measureText(name).width * 200) / 512,
        degree: connections.filter((c) => c.from === person.id || c.to === person.id).length,
        velocity: new THREE.Vector3(),
      });
    }
    for (const connection of connections) {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.3 }),
      );
      state.group.add(line);
      state.edges.push({ connection, line });
    }
    state.heat = 400;
  }, [people, connections, ink, edgeColor, font]);
  return (
    <div ref={host} className="absolute inset-0" data-testid="rolodex-graph">
      {error && (
        <p className="absolute left-4 top-4 max-w-xs text-[13px] text-neutral-400">
          This browser can’t draw the 3D graph. The people list and chat still work.
        </p>
      )}
    </div>
  );
}
function disposeGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      child.material.dispose();
    }
    if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
    }
    group.remove(child);
  }
}
