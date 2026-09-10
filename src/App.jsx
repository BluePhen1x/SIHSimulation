import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import osmtogeojson from 'osmtogeojson';
import './App.css';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const CENTER_LAT = 12.9720;
const CENTER_LON = 77.5945;
const LAT_SCALE = 111320;
const LON_SCALE = 111320 * Math.cos((CENTER_LAT * Math.PI) / 180);
const HALF_EXTENT_M = 1750;
const BOUNDS = {
  minLat: CENTER_LAT - HALF_EXTENT_M / LAT_SCALE,
  maxLat: CENTER_LAT + HALF_EXTENT_M / LAT_SCALE,
  minLon: CENTER_LON - HALF_EXTENT_M / LON_SCALE,
  maxLon: CENTER_LON + HALF_EXTENT_M / LON_SCALE,
};
const OVERPASS_QUERY =
  '[out:json][timeout:60];' +
  `(way["building"](${BOUNDS.minLat.toFixed(6)},${BOUNDS.minLon.toFixed(6)},${BOUNDS.maxLat.toFixed(6)},${BOUNDS.maxLon.toFixed(6)});` +
  `way["highway"](${BOUNDS.minLat.toFixed(6)},${BOUNDS.minLon.toFixed(6)},${BOUNDS.maxLat.toFixed(6)},${BOUNDS.maxLon.toFixed(6)}););` +
  'out body;>;out skel qt;';

const CACHE_KEY = 'bangalore-osm-cache-v2';

const BLIMP_HEIGHT = 1000;
const COVERAGE_RADIUS = 700;
const COVERAGE_OFFSET = 600;

// Vehicle traffic simulation constants. Scene units are meters (LAT_SCALE /
// LON_SCALE map degrees to meters), so a speed in m/s is directly usable.
const VEHICLE_MAX = 200;
const VEHICLE_KPH_MIN = 20;
const VEHICLE_KPH_MAX = 60;
const VEHICLE_SPAWN_MIN_S = 0.2;
const VEHICLE_SPAWN_MAX_S = 0.6;
const VEHICLE_MAX_AGE_S = 150;
// Vehicle paths live at this height; the vehicle's bottom (~y 0.3) sits
// directly on the road surface, which both road styles render at y 0.3.
const VEHICLE_Y = 1.7;
const EDGE_RADIUS = 1400;

// Panel toggle definitions. The control panel renders itself from this list,
// so a new layer only needs one entry here plus registering its group in
// groupsRef during init(). Each entry maps to a Three.js group that the
// toggle shows/hides via .visible — no data is ever re-fetched.
// TODO: Add toggles here for ground cameras once built.
const TOGGLE_CONFIG = [
  { id: 'roads', label: 'Roads', defaultVisible: true },
  { id: 'blimp', label: 'Blimp', defaultVisible: false },
  { id: 'vehicles', label: 'Vehicles', defaultVisible: true },
];

async function fetchOverpassData() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // stale or oversized cache, ignore and fall through
  }

  try {
    const module = await import('./data/bangalore-cache.json');
    return module.default;
  } catch {
    // cache file not present, fetch live
  }

  // localStorage caps around 5-10MB; the full 3.5km dataset may exceed it
  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: OVERPASS_QUERY,
  });
  if (!resp.ok) throw new Error(`Overpass API error: ${resp.status}`);
  const data = await resp.json();
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // quota exceeded (dataset > ~5MB); cached JSON file already covers this
  }
  return data;
}

function projectCoord(lon, lat) {
  const x = (lon - CENTER_LON) * LON_SCALE;
  const z = -(lat - CENTER_LAT) * LAT_SCALE;
  return [x, z];
}

function projectRing(ring) {
  const coords = [];
  for (const [lon, lat] of ring) {
    const [x, z] = projectCoord(lon, lat);
    coords.push(new THREE.Vector2(x, z));
  }
  return coords;
}

function getBuildingHeight(tags) {
  if (tags['height']) {
    const h = parseFloat(tags['height']);
    if (!isNaN(h)) return h;
  }
  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!isNaN(levels)) return levels * 3;
  }
  return 15;
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function getBuildingColor(props) {
  const type = String(props.building || props['building:part'] || '').toLowerCase();

  if (type === 'commercial' || type === 'retail') {
    return new THREE.Color(0xffb74d);
  }
  if (type === 'residential' || type === 'apartments' || type === 'house') {
    return new THREE.Color(0x9cc3ea);
  }

  // hide everything else (soft-white/gray defaults) for now
  return null;
}

function createBuildingMesh(footprint, height, color) {
  const shape = new THREE.Shape(footprint);
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
  });

  const faceMat = new THREE.MeshPhongMaterial({
    color,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, faceMat);
  mesh.rotation.x = -Math.PI / 2;

  const edgeColor = color.clone().lerp(new THREE.Color(0xffffff), 0.55);
  const edges = new THREE.EdgesGeometry(geom);
  const lineMat = new THREE.LineBasicMaterial({
    color: edgeColor,
    transparent: true,
    opacity: 0.9,
  });
  const lineSegments = new THREE.LineSegments(edges, lineMat);
  lineSegments.rotation.x = -Math.PI / 2;

  const group = new THREE.Group();
  group.add(mesh);
  group.add(lineSegments);
  return group;
}

// --- Shared road-centerline geometry ------------------------------------
// Everything (rendered road lines AND vehicle paths) derives from one source
// of truth: the same GeoJSON coordinates projected through projectCoord().
// Road lines are CatmullRom curves through the real OSM node points, and
// vehicles ride the very same curve, so they sit exactly on the road.

function projectRoadPoints(coords, y) {
  const points = coords.map(([lon, lat]) => {
    const [x, z] = projectCoord(lon, lat);
    return new THREE.Vector3(x, y, z);
  });
  return points;
}

function buildRoadCurve(coords, y) {
  const points = projectRoadPoints(coords, y);
  if (points.length < 2) return null;
  return new THREE.CatmullRomCurve3(points);
}

function createRoadLine(coords) {
  const curve = buildRoadCurve(coords, 0.3);
  if (!curve) return null;
  const tubularSegments = Math.max(3, Math.round(curve.getLength() / 8));
  const geom = new THREE.TubeGeometry(curve, tubularSegments, 1.2, 4, false);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff9100 });
  return new THREE.Mesh(geom, mat);
}

// Original road style: every highway way rendered as a thin 3D line. It now
// follows the SAME CatmullRom curve as the tube roads (and the vehicles), so
// no matter which road style is shown, cars ride exactly on the visible line.
function createOrigRoadLine(coords) {
  const curve = buildRoadCurve(coords, 0.3);
  if (!curve) return null;
  const sampled = curve.getPoints(Math.max(2, Math.round(curve.getLength() / 6)));
  const geom = new THREE.BufferGeometry().setFromPoints(sampled);
  const mat = new THREE.LineBasicMaterial({ color: 0xff9100, linewidth: 2 });
  return new THREE.Line(geom, mat);
}

function createCoverageDisc(color, x, z) {
  const geom = new THREE.CircleGeometry(COVERAGE_RADIUS, 48);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.05, z);
  return mesh;
}

function createCoverageRing(color, x, z) {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push(new THREE.Vector3(x + Math.cos(a) * COVERAGE_RADIUS, 0.3, z + Math.sin(a) * COVERAGE_RADIUS));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const edge = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
  const mat = new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: 0.9 });
  return new THREE.Line(geom, mat);
}

function createBlimpVisualization() {
  const group = new THREE.Group();

  const coverage = [
    { color: new THREE.Color(0x00e5ff), x: 0, z: 0 },
    { color: new THREE.Color(0x00c853), x: 0, z: -COVERAGE_OFFSET },
    { color: new THREE.Color(0x018786), x: 0, z: COVERAGE_OFFSET },
    { color: new THREE.Color(0xaeea00), x: -COVERAGE_OFFSET, z: 0 },
    { color: new THREE.Color(0x26c6da), x: COVERAGE_OFFSET, z: 0 },
  ];

  for (const c of coverage) {
    group.add(createCoverageDisc(c.color, c.x, c.z));
    group.add(createCoverageRing(c.color, c.x, c.z));
  }

  const beacon = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, BLIMP_HEIGHT, 0),
  ]);
  const beaconMat = new THREE.LineBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 0.25,
  });
  group.add(new THREE.Line(beacon, beaconMat));

  const blimpGroup = new THREE.Group();
  blimpGroup.position.set(0, BLIMP_HEIGHT, 0);

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(35, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff })
  );
  blimpGroup.add(body);

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(42, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
    })
  );
  blimpGroup.add(shell);

  group.add(blimpGroup);
  return group;
}

function createVehicleMesh() {
  const geom = new THREE.BoxGeometry(4.2, 2.8, 9.5);
  const mat = new THREE.MeshPhongMaterial({
    color: 0xff2020,
    emissive: 0xff2020,
    emissiveIntensity: 1,
  });
  return new THREE.Mesh(geom, mat);
}

function junctionKey(p) {
  return `${Math.round(p.x * 10)}_${Math.round(p.z * 10)}`;
}

// Build { scenePointKey -> [{ si, end }] }: for every road segment endpoint,
// the set of segments meeting there. Shared OSM nodes produce shared scene
// points, so ways that intersect in the real network meet here too.
function buildRoadJunctions(roads) {
  const junctions = new Map();
  roads.forEach((road, si) => {
    for (const end of [0, road.nodes.length - 1]) {
      const k = junctionKey(road.nodes[end]);
      if (!junctions.has(k)) junctions.set(k, []);
      junctions.get(k).push({ si, end });
    }
  });
  return junctions;
}

// Directed road endpoints near the boundary of the loaded area — these are
// the spots vehicles enter the network from.
function collectEntryPoints(roads) {
  const entries = [];
  roads.forEach((road, si) => {
    for (const end of [0, road.nodes.length - 1]) {
      const p = road.nodes[end];
      const r = Math.hypot(p.x, p.z);
      if (r >= EDGE_RADIUS && r <= HALF_EXTENT_M) entries.push({ si, end });
    }
  });
  return entries;
}

// Sample a moving vehicle on its current road curve. The curve is the very
// same CatmullRom geometry the rendered road lines use, so the vehicle sits
// exactly on the road and faces the direction of travel.
function vehiclePosition(v, road) {
  const t = v.dir === 1 ? Math.min(1, Math.max(0, v.t)) : Math.min(1, Math.max(0, 1 - v.t));
  // getPoint (polynomial evaluation) is robust on degenerate curves;
  // getPointAt uses an arc-length table that can produce discontinuous
  // jumps on self-intersecting OSM projections.
  const pos = road.curve.getPoint(t);
  const tan = road.curve.getTangent(t);
  const dir = v.dir === 1 ? tan : tan.clone().negate();
  return { pos, dir };
}

// At the end of a segment, pick the next road to travel on: prefer any other
// segment meeting at this junction, allowing a cautious U-turn on a cul-de-sac.
// Returns null when the vehicle should leave the network (edge of the loaded
// area, or a dead end it won't turn around on). A transition always starts on
// the shared junction node coordinate, so vehicles never jump off-path.
function pickNextSegment(roads, junctions, si, dir, arrival) {
  if (Math.hypot(arrival.x, arrival.z) >= HALF_EXTENT_M) return null;
  const conn = junctions.get(junctionKey(arrival));
  if (!conn) return null;
  const nodes = roads[si].nodes;
  const curEnd = dir === 1 ? nodes.length - 1 : 0;
  const others = conn.filter((c) => !(c.si === si && c.end === curEnd));
  let pick;
  if (others.length > 0) {
    pick = others[(Math.random() * others.length) | 0];
  } else if (Math.random() < 0.35) {
    pick = conn.find((c) => c.si === si && c.end === curEnd);
  } else {
    return null;
  }
  return { si: pick.si, dir: pick.end === 0 ? 1 : -1 };
}

// Advance a vehicle along its current road curve. Returns true when the
// vehicle should be removed (travel time exhausted, or no road to continue on).
// v.t is the parametric fraction [0,1] along the CatmullRom curve.
// Transitions are gated by actual position-to-node distance (not the
// parametric estimate), so even degenerate self-intersecting OSM projections
// never teleport the vehicle.
function advanceVehicle(v, roads, junctions, dt, maxAge) {
  v.age += dt;
  let remaining = v.speed * dt;
  if (remaining <= 0) return v.age > maxAge;
  let guard = 0;
  while (remaining > 1e-6 && guard++ < 16) {
    const road = roads[v.si];
    const endIdx = v.dir === 1 ? road.nodes.length - 1 : 0;
    const curPos = road.curve.getPoint(Math.min(1, Math.max(0, v.dir === 1 ? v.t : 1 - v.t)));
    const toEnd = curPos.distanceTo(road.nodes[endIdx]);
    if (toEnd > 0.8 && remaining < toEnd) {
      const delta = remaining / road.len;
      if (v.dir === 1) v.t = Math.min(v.t + delta, 1);
      else v.t = Math.max(v.t - delta, 0);
      remaining = 0;
    } else {
      const next = pickNextSegment(roads, junctions, v.si, v.dir, road.nodes[endIdx]);
      if (!next) return true;
      // Reset to the junction node; don't carry remaining into the next
      // road's degenerate CatmullRom, where getPoint(t) can jump wildly
      // for small t on self-intersecting OSM projections.
      v.si = next.si;
      v.dir = next.dir;
      v.t = 0;
      remaining = 0;
    }
  }
  return v.age > maxAge;
}

export default function App() {
  const containerRef = useRef(null);
  const groupsRef = useRef({});
  const [status, setStatus] = useState('Loading OpenStreetMap data...');
  const [stats, setStats] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [layerVisible, setLayerVisible] = useState(() =>
    Object.fromEntries(TOGGLE_CONFIG.map((entry) => [entry.id, entry.defaultVisible]))
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer, scene, camera, controls, animId;

    async function init() {
      try {
        setStatus('Fetching building & road data from Overpass API...');
        const osmData = await fetchOverpassData();

        setStatus('Converting to GeoJSON...');
        const geojson = osmtogeojson(osmData);

        // Scene setup
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0a1a);
        scene.fog = new THREE.FogExp2(0x0a0a1a, 0.00015);

        camera = new THREE.PerspectiveCamera(
          60,
          container.clientWidth / container.clientHeight,
          0.1,
          50000
        );
        camera.position.set(0, 1600, 2400);
        camera.lookAt(0, 0, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        // Lighting
        const ambient = new THREE.AmbientLight(0x30304d, 1.0);
        scene.add(ambient);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(500, 2000, 1000);
        scene.add(dirLight);
        const pointLight = new THREE.PointLight(0xffffff, 0.6, 5000);
        pointLight.position.set(0, 500, 0);
        scene.add(pointLight);

        // Ground grid
        const gridHelper = new THREE.GridHelper(2400, 40, 0x1a1a3a, 0x111128);
        gridHelper.position.y = -0.5;
        scene.add(gridHelper);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0, 0);
        controls.minDistance = 30;
        controls.maxDistance = 6000;
        controls.maxPolarAngle = Math.PI / 2.1;

        // Process features
        let buildingCount = 0;
        let roadCount = 0;

        const buildingGroup = new THREE.Group();
        const roadGroup = new THREE.Group();
        const roadGroupCurrent = new THREE.Group();
        const roadSegments = [];

        const visibleRoadTypes = new Set([
          'motorway',
          'trunk',
          'primary',
          'secondary',
          'tertiary',
        ]);

        for (const feature of geojson.features) {
          const props = feature.properties || {};
          const geom = feature.geometry;

          const isBuilding = props.building || props['building:part'];
          const isRoad = props.highway;

          if (isBuilding) {
            const height = getBuildingHeight(props);
            const polys =
              geom.type === 'Polygon'
                ? [geom.coordinates]
                : geom.type === 'MultiPolygon'
                ? geom.coordinates
                : [];

            for (const poly of polys) {
              const outer = poly[0];
              if (!outer || outer.length < 3) continue;
              const footprint = projectRing(outer);
              try {
                const color = getBuildingColor(props);
                if (!color) continue; // skip temporarily-hidden default/gray buildings
                const mesh = createBuildingMesh(footprint, height, color);
                mesh.position.y = 0;
                buildingGroup.add(mesh);
                buildingCount++;
              } catch {
                // skip degenerate polygons
              }
            }
          } else if (isRoad) {
            let coords;

            if (geom.type === 'LineString') {
              coords = geom.coordinates;
            } else if (geom.type === 'MultiLineString') {
              coords = geom.coordinates.flat();
            } else {
              continue;
            }

            // Original road set (shown when the Roads toggle is ON): every
            // highway way as a thin line, matching the initial version.
            const origLine = createOrigRoadLine(coords);
            if (origLine) roadGroup.add(origLine);

            // Vehicles travel the road geometry that appears when the Roads
            // toggle is OFF: the same OSM node points and the same CatmullRom
            // curves used to render those tube roads (identical projectCoord /
            // LON/LAT scale), just at vehicle height. Roads with degenerate
            // geometry (self-intersecting CatmullRom projections) are filtered
            // out so the curve sampling never produces off-curve jumps.
            if (visibleRoadTypes.has(String(props.highway))) {
              const nodes = projectRoadPoints(coords, VEHICLE_Y);
              const curve = buildRoadCurve(coords, VEHICLE_Y);
              if (curve && nodes.length >= 2) {
                let nodePathLen = 0;
                let minSeg = Infinity;
                for (let i = 0; i < nodes.length - 1; i++) {
                  const d = nodes[i].distanceTo(nodes[i + 1]);
                  nodePathLen += d;
                  if (d < minSeg) minSeg = d;
                }
                const curveLen = curve.getLength();
                const loopRatio = curveLen / (nodePathLen || 1);
                if (minSeg >= 1.0 && loopRatio < 2.2 && curveLen > 2.0) {
                  roadSegments.push({ nodes, curve, len: curveLen });
                }
              }
            }

            // Current road set (shown when the Roads toggle is OFF): only
            // major road types as widened tubes. Only these count toward the
            // HUD road tally, keeping the existing behavior unchanged.
            if (visibleRoadTypes.has(String(props.highway))) {
              const line = createRoadLine(coords);
              if (line) {
                roadGroupCurrent.add(line);
                roadCount++;
              }
            }
          }
        }

        scene.add(buildingGroup);
        scene.add(roadGroup);
        scene.add(roadGroupCurrent);

        // Vehicle road graph + group.
        const junctions = buildRoadJunctions(roadSegments);
        const entryPoints = collectEntryPoints(roadSegments);
        const vehiclesGroup = new THREE.Group();
        vehiclesGroup.visible = true;
        scene.add(vehiclesGroup);

        // Roads toggle swaps between original (ON) and current (OFF) sets.
        // Exposing it as a swap object that presents a plain `.visible`
        // property keeps the generic panel toggle handler unchanged.
        groupsRef.current.roads = {
          get visible() {
            return roadGroup.visible;
          },
          set visible(value) {
            roadGroup.visible = value;
            roadGroupCurrent.visible = !value;
          },
        };
        groupsRef.current.blimp = createBlimpVisualization();
        groupsRef.current.vehicles = vehiclesGroup;

        // Apply the configured default visibility the moment groups exist,
        // so the blimp (OFF by default) never flashes before toggles settle.
        for (const entry of TOGGLE_CONFIG) {
          const group = groupsRef.current[entry.id];
          if (group) group.visible = entry.defaultVisible;
        }

        scene.add(groupsRef.current.blimp);

        setStats({ buildings: buildingCount, roads: roadCount });
        setStatus('Rendered');

        // Live traffic simulation: spawn vehicles at the edge of the loaded
        // area, drive them along real road geometry, and retire them at the
        // boundary or after a max travel time.
        const vehicles = [];
        let nextVehicleId = 0;
        let prevT = performance.now();
        let spawnTimer = VEHICLE_SPAWN_MIN_S;

        function spawnVehicleInArea() {
          if (entryPoints.length === 0) return null;
          const e = entryPoints[(Math.random() * entryPoints.length) | 0];
          const mesh = createVehicleMesh();
          const start = vehiclePosition(
            { si: e.si, dir: e.end === 0 ? 1 : -1, t: 0 },
            roadSegments[e.si]
          );
          mesh.position.copy(start.pos);
          mesh.rotation.y = Math.atan2(start.dir.x, start.dir.z);
          vehiclesGroup.add(mesh);
          return {
            id: nextVehicleId++,
            mesh,
            si: e.si,
            dir: e.end === 0 ? 1 : -1,
            t: 0,
            speed: (VEHICLE_KPH_MIN + Math.random() * (VEHICLE_KPH_MAX - VEHICLE_KPH_MIN)) / 3.6,
            age: 0,
          };
        }

        function animate() {
          animId = requestAnimationFrame(animate);
          const now = performance.now();
          const dt = Math.min((now - prevT) / 1000, 0.1);
          prevT = now;

          spawnTimer -= dt;
          if (spawnTimer <= 0) {
            if (vehicles.length < VEHICLE_MAX) {
              const v = spawnVehicleInArea();
              if (v) vehicles.push(v);
            }
            spawnTimer =
              VEHICLE_SPAWN_MIN_S +
              Math.random() * (VEHICLE_SPAWN_MAX_S - VEHICLE_SPAWN_MIN_S);
          }

          for (let i = vehicles.length - 1; i >= 0; i--) {
            const v = vehicles[i];
            if (advanceVehicle(v, roadSegments, junctions, dt, VEHICLE_MAX_AGE_S)) {
              vehiclesGroup.remove(v.mesh);
              vehicles.splice(i, 1);
            } else {
              const { pos, dir } = vehiclePosition(v, roadSegments[v.si]);
              v.mesh.position.copy(pos);
              v.mesh.rotation.y = Math.atan2(dir.x, dir.z);
            }
          }

          controls.update();
          renderer.render(scene, camera);
        }
        animate();

        function onResize() {
          camera.aspect = container.clientWidth / container.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(container.clientWidth, container.clientHeight);
        }
        window.addEventListener('resize', onResize);

        return () => window.removeEventListener('resize', onResize);
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`);
      }
    }

    const cleanupPromise = init();

    return () => {
      if (animId) cancelAnimationFrame(animId);
      controls?.dispose();
      renderer?.dispose();
      container.removeChild(renderer.domElement);
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, []);

  return (
    <div className="app">
      <div ref={containerRef} className="scene-container" />
      {status !== 'Rendered' && (
        <div className="overlay">
          <div className="spinner" />
          <p>{status}</p>
        </div>
      )}
      {stats && (
        <div className="hud">
          <span>{stats.buildings} buildings</span>
          <span className="sep">|</span>
          <span>{stats.roads} roads</span>
        </div>
      )}
      <div className={`control-panel${panelOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="panel-tab"
          onClick={() => setPanelOpen((open) => !open)}
          aria-label={panelOpen ? 'Hide layer controls' : 'Show layer controls'}
        >
          {panelOpen ? '›' : '‹'}
        </button>
        <div className="panel-body">
          <h2 className="panel-title">Layers</h2>
          <ul className="toggle-list">
            {TOGGLE_CONFIG.map((entry) => (
              <li key={entry.id} className="toggle-item">
                <label className="toggle-row">
                  <span className="toggle-label">{entry.label}</span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={layerVisible[entry.id]}
                      onChange={(event) => {
                        const visible = event.target.checked;
                        setLayerVisible((prev) => ({ ...prev, [entry.id]: visible }));
                        const group = groupsRef.current[entry.id];
                        if (group) group.visible = visible;
                      }}
                    />
                    <span className="track" />
                    <span className="thumb" />
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
