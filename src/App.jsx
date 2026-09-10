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
const VEHICLE_MAX_AGE_S = 150;
// ANPR fusion thresholds. Sightings of the same plate inside FUSION_CONCURRENT_S
// are treated as one simultaneous observation (no transit segment); a camera-to-
// camera implied speed above FUSION_MAX_IMPLIED_KPH flags a suspicious jump.
const FUSION_CONCURRENT_S = 1;
const FUSION_MAX_IMPLIED_KPH = 130;
// How many journeys the fusion panel lists (most sightings first).
const FUSION_MAX_LISTED = 6;
// Vehicle paths live at this height; the vehicle's bottom (~y 0.3) sits
// directly on the road surface, which both road styles render at y 0.3.
const VEHICLE_Y = 1.7;
// Max distance (scene units) a clicked point can be from a drivable road
// centerline for a click-to-spawn to register.
const CLICK_SPAWN_MAX_DIST = 4;
// When the click lands on a thin road line (the all-highways view) whose
// road isn't itself drivable, pick the nearest drivable road within this
// distance instead.
const ROAD_CLICK_LOOSE_DIST = 25;

// Panel toggle definitions. The control panel renders itself from this list,
// so a new layer only needs one entry here plus registering its group in
// groupsRef during init(). Each entry maps to a Three.js group that the
// toggle shows/hides via .visible — no data is ever re-fetched.
// TODO: Add toggles here for ground cameras once built.
const TOGGLE_CONFIG = [
  { id: 'roads', label: 'Roads', defaultVisible: true },
  { id: 'blimp', label: 'Blimp', defaultVisible: false },
  { id: 'vehicles', label: 'Vehicles', defaultVisible: true },
  { id: 'cameras', label: 'Ground Cameras', defaultVisible: true },
  { id: 'fov', label: 'Camera FOV', defaultVisible: true },
  { id: 'detections', label: 'Detection Overlay', defaultVisible: true },
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

// Ground ANPR camera constants. Cameras sit on a short pole at an
// intersection and watch the road ahead with a soft purple FOV wedge --
// visually distinct from the blimp's cyan/green coverage discs.
const CAM_POLE_HEIGHT = 6;
const CAM_HEAD_Y = 6.15;
const CAM_FOV_LENGTH = 90;
const CAM_FOV_HALF_ANGLE = 0.5; // radians (~28.6 deg), ~half the road fan

// Shared geometry/materials for the camera network. Every camera reuses these
// (431+ instances), which keeps the draw-call and memory cost flat regardless
// of how dense the network gets.
const CAM_POLE_GEO = new THREE.CylinderGeometry(0.14, 0.2, CAM_POLE_HEIGHT, 8);
const CAM_HEAD_GEO = new THREE.BoxGeometry(0.6, 0.5, 1.2);
const CAM_BEACON_GEO = new THREE.SphereGeometry(10, 12, 10);
const CAM_POLE_MAT = new THREE.MeshLambertMaterial({ color: 0x9aa3b5 });
const CAM_HEAD_MAT = new THREE.MeshLambertMaterial({ color: 0x1c1e2a });
const CAM_BEACON_MAT = new THREE.MeshBasicMaterial({ color: 0x00e5ff, fog: false });

// Camera body: thin pole with a small headed box on top plus a bright cyan
// beacon so every deployed camera reads from the overview. The group's local
// +Z axis faces the road under surveillance (caller sets group.rotation.y),
// so the head and FOV wedge both aim the same way. The cone mesh/geometry are
// built once per network density and shared by every camera.
function createGroundCamera(pos, dir, coneGeom, coneMat) {
  const group = new THREE.Group();

  const pole = new THREE.Mesh(CAM_POLE_GEO, CAM_POLE_MAT);
  pole.position.y = CAM_POLE_HEIGHT / 2;
  group.add(pole);

  const head = new THREE.Mesh(CAM_HEAD_GEO, CAM_HEAD_MAT);
  head.position.y = CAM_HEAD_Y;
  group.add(head);

  const beacon = new THREE.Mesh(CAM_BEACON_GEO, CAM_BEACON_MAT);
  beacon.position.y = CAM_HEAD_Y + 8;
  group.add(beacon);

  // Semi-transparent FOV wedge: apex at the camera head, opening toward the
  // monitored road. Built with apex at local origin pointing +Z; the group's
  // rotation.y aims it along |dir|. When many cameras are in the scene the
  // cones get smaller segments and a fainter fill so the map stays readable.
  const fov = new THREE.Mesh(coneGeom, coneMat);
  fov.position.y = CAM_HEAD_Y;
  fov.userData.isFov = true;
  group.add(fov);

  group.position.set(pos.x, 0, pos.z);
  group.rotation.y = Math.atan2(dir.x, dir.z);
  return group;
}

// Unit horizontal direction from a junction node into the body of a road,
// so a camera aimed along it covers the stretch leaving the intersection.
function roadDirectionOutward(road, junctionAtStart) {
  const n = road.nodes;
  if (junctionAtStart) {
    const to = n[1] || n[n.length - 1];
    return new THREE.Vector3(to.x - n[0].x, 0, to.z - n[0].z).normalize();
  }
  const to = n[n.length - 2] || n[0];
  return new THREE.Vector3(
    n[n.length - 1].x - to.x,
    0,
    n[n.length - 1].z - to.z
  ).normalize();
}

// Assign every vehicle ONE simulated plate at spawn. Roughly 1 in 10 get no
// plate (obscured / missing / unreadable), which stays null across every
// camera that later sights the vehicle.
function generatePlate() {
  if (Math.random() < 0.1) return null;
  const stateDigits = String(1 + Math.floor(Math.random() * 29)).padStart(2, '0');
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ'; // no I / O / Q to look plate-like
  const l2 =
    letters[Math.floor(Math.random() * letters.length)] +
    letters[Math.floor(Math.random() * letters.length)];
  const num = String(1000 + Math.floor(Math.random() * 9000));
  return `KA ${stateDigits} ${l2} ${num}`;
}

// True when a world-space point lies inside a camera's FOV cone: apex at the
// camera head, axis along the monitored-road direction, half-angle
// CAM_FOV_HALF_ANGLE. 3D test, so height above the road counts too. Uses the
// precomputed per-camera fields on `cam` (ax..dz, halfTan2, maxR2) and cheap
// rejects, so updateDetections can test every vehicle against every camera
// without allocating or slowing the frame loop down.
function pointInFov(point, cam) {
  const dx = point.x - cam.ax;
  const dy = point.y - cam.ay;
  const dz = point.z - cam.az;
  if (dx * dx + dz * dz > cam.maxR2) return false;
  const t = dx * cam.dx + dy * cam.dy + dz * cam.dz;
  if (t < 0 || t > cam.length) return false;
  const radial2 = dx * dx + dy * dy + dz * dz - t * t;
  return radial2 <= t * t * cam.halfTan2;
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

// At the end of a segment, pick the next road to travel on: any OTHER segment
// meeting at this junction. The incoming segment is always excluded, so a
// vehicle never reverses onto the road it just drove. Returns null when the
// vehicle should leave the network (edge of the loaded area, or a dead end
// with no onward road) instead of turning back. A transition always starts on
// the shared junction node coordinate, so vehicles never jump off-path.
function pickNextSegment(roads, junctions, si, dir, arrival) {
  if (Math.hypot(arrival.x, arrival.z) >= HALF_EXTENT_M) return null;
  const conn = junctions.get(junctionKey(arrival));
  if (!conn) return null;
  const nodes = roads[si].nodes;
  const curEnd = dir === 1 ? nodes.length - 1 : 0;
  const others = conn.filter((c) => !(c.si === si && c.end === curEnd));
  if (others.length === 0) return null;
  const pick = others[(Math.random() * others.length) | 0];
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
  // Arc-length motion: the CatmullRom's getPoint(t) is arc-length
  // parameterized (t in [0,1] maps linearly onto the curve's length), so the
  // distance left on the current road is (1 - t) * len in either direction
  // (v.t is "fraction traveled toward the exit", 0 = just entered, 1 = at the
  // exit node). Moving in parameter space by remaining / len covers exactly
  // `remaining` meters, and leftover distance is carried into the next road so
  // junction handoffs never stall the car.
  while (remaining > 1e-6 && guard++ < 16) {
    const road = roads[v.si];
    const toEnd = (1 - v.t) * road.len;
    if (remaining < toEnd) {
      v.t = Math.min(v.t + remaining / road.len, 1);
      remaining = 0;
    } else {
      const endIdx = v.dir === 1 ? road.nodes.length - 1 : 0;
      const next = pickNextSegment(roads, junctions, v.si, v.dir, road.nodes[endIdx]);
      if (!next) return v.age > maxAge;
      remaining -= toEnd;
      v.si = next.si;
      v.dir = next.dir;
      v.t = 0;
    }
  }
  return v.age > maxAge;
}

export default function App() {
  const containerRef = useRef(null);
  const groupsRef = useRef({});
  const clearVehiclesRef = useRef(null);
  const sightingsRef = useRef([]);
  const fusionApiRef = useRef(null);
  const [fusionSnap, setFusionSnap] = useState(null);
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
        const vehiclesGroup = new THREE.Group();
        vehiclesGroup.visible = true;
        scene.add(vehiclesGroup);

// Ground ANPR camera network: one camera at every intersection (>= 2 distinct
        // roads). Each monitors its longest connecting road. cameraData mirrors
        // cameraGroup so detections can cone-test in 3D; precomputed fields keep
        // the per-frame FOV test allocation-free.
        const cameraGroup = new THREE.Group();
        const cameraData = [];
        {
          const sites = [];
          junctions.forEach((conn) => {
            const distinctRoads = new Set(conn.map((c) => c.si));
            if (distinctRoads.size < 2) return;
            const node = roadSegments[conn[0].si].nodes[conn[0].end];
            sites.push({ node: node.clone(), conn, degree: distinctRoads.size });
          });
          sites.sort((a, b) => b.degree - a.degree);
          const coneSegs = sites.length > 80 ? 12 : 24;
          const coneOpacity = sites.length > 80 ? 0.1 : sites.length > 40 ? 0.13 : 0.16;
          const radius = Math.tan(CAM_FOV_HALF_ANGLE) * CAM_FOV_LENGTH;
          const coneGeom = new THREE.ConeGeometry(radius, CAM_FOV_LENGTH, coneSegs, 1, true);
          coneGeom.rotateX(-Math.PI / 2);
          coneGeom.translate(0, 0, CAM_FOV_LENGTH / 2);
          const coneMat = new THREE.MeshBasicMaterial({
            color: 0xc44dff,
            transparent: true,
            opacity: coneOpacity,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          sites.forEach((site, i) => {
            let monitored = site.conn[0];
            for (const c of site.conn) {
              if (roadSegments[c.si].len > roadSegments[monitored.si].len) monitored = c;
            }
            const dir = roadDirectionOutward(roadSegments[monitored.si], monitored.end === 0);
            cameraGroup.add(createGroundCamera(site.node, dir, coneGeom, coneMat));
            const apex = new THREE.Vector3(site.node.x, CAM_HEAD_Y, site.node.z);
            const halfTan = Math.tan(CAM_FOV_HALF_ANGLE);
            cameraData.push({
              id: `CAM-${String(i + 1).padStart(2, '0')}`,
              group: cameraGroup.children[i],
              apex,
              dir,
              length: CAM_FOV_LENGTH,
              halfTan,
              ax: apex.x,
              ay: apex.y,
              az: apex.z,
              dx: dir.x,
              dy: dir.y,
              dz: dir.z,
              halfTan2: halfTan * halfTan,
              maxR2: (CAM_FOV_LENGTH * Math.sqrt(1 + halfTan * halfTan)) ** 2,
            });
          });
        }
        scene.add(cameraGroup);

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
        groupsRef.current.cameras = cameraGroup;
        // FOV cones toggle: keeps the poles/heads but hides the purple wedges.
        // Not a THREE group, so expose the same .visible contract by flipping
        // every tagged cone mesh in the camera group.
        const fovOn = { value: true };
        groupsRef.current.fov = {
          get visible() {
            return fovOn.value;
          },
          set visible(value) {
            fovOn.value = value;
            cameraGroup.children.forEach((g) =>
              g.children.forEach((m) => {
                if (m.userData.isFov) m.visible = value;
              })
            );
          },
        };
        // Overlays are DOM/3D, not a THREE group, so the toggle is a simple
        // flag exposed behind the same .visible contract as the other layers.
        // Declared before the default-visibility loop below, which immediately
        // invokes the setter.
        const detectionOverlayOn = { value: true };
        groupsRef.current.detections = {
          get visible() {
            return detectionOverlayOn.value;
          },
          set visible(value) {
            detectionOverlayOn.value = value;
          },
        };

        // Apply the configured default visibility the moment groups exist,
        // so the blimp (OFF by default) never flashes before toggles settle.
        for (const entry of TOGGLE_CONFIG) {
          const group = groupsRef.current[entry.id];
          if (group) group.visible = entry.defaultVisible;
        }

        scene.add(groupsRef.current.blimp);

        setStats({ buildings: buildingCount, roads: roadCount, cameras: cameraData.length });
        setStatus('Rendered');

        // Live traffic simulation. Vehicles only appear via click-to-spawn: a left
// click on a visible road creates a car there in a random direction (same
// cap, junction, and removal logic). Right-click a vehicle to pin/unpin its
// live speed label and left-clicking elsewhere dismisses it.
const vehicles = [];
        let nextVehicleId = 0;
        let prevT = performance.now();
        let selectedVehicle = null;

        const labelEl = document.createElement('div');
        labelEl.className = 'vehicle-label';
        labelEl.style.display = 'none';
        container.appendChild(labelEl);

        // Per-camera HTML labels (e.g. "CAM-01") shown when hovering a camera.
        const cameraLabels = cameraData.map((cam) => {
          const el = document.createElement('div');
          el.className = 'camera-label';
          el.textContent = cam.id;
          el.style.display = 'none';
          container.appendChild(el);
          return el;
        });
        let hoveredCamera = null;

        // Detection overlay state. Active sightings are per vehicle; the box +
        // plate label stay up while the vehicle remains inside a camera's FOV.
        const activeSightings = new Map();

        function createDetectionOverlay(noPlate) {
          const box = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(4.6, 3.2, 9.9)),
            new THREE.LineBasicMaterial({ color: noPlate ? 0xff5252 : 0x00e5ff })
          );
          const el = document.createElement('div');
          el.className = noPlate ? 'detection-label no-plate' : 'detection-label';
          el.style.display = 'none';
          container.appendChild(el);
          return { box, el };
        }

        function tearDownSighting(id) {
          const s = activeSightings.get(id);
          if (!s) return;
          if (s.overlay.box.parent) s.overlay.box.parent.remove(s.overlay.box);
          s.overlay.el.remove();
          activeSightings.delete(id);
        }

        // ANPR fusion: correlate per-camera sighting records (same plate) into
        // journeys. A journey is the plate's camera chain in sighting order;
        // each new stop may add a transit segment whose implied speed is the
        // straight-line distance over elapsed time. No-plate sightings carry no
        // identity, so they only feed an anonymous counter. The panel reads a
        // snapshot via fusionApiRef; clicking a journey traces its path in 3D.
        const journeys = new Map();
        let anonCount = 0;
        const journeyGroup = new THREE.Group();
        scene.add(journeyGroup);
        let journeyLine = null;

        function fuseSighting(r) {
          if (!r.plateNumber) {
            anonCount++;
            return;
          }
          let j = journeys.get(r.plateNumber);
          if (!j) {
            j = { plate: r.plateNumber, stops: [], segments: [], alerts: [] };
            journeys.set(r.plateNumber, j);
          }
          const cam = cameraData.find((c) => c.id === r.cameraId);
          const stop = {
            cameraId: r.cameraId,
            timestamp: r.timestamp,
            speedKmh: r.speed,
            x: cam ? cam.apex.x : 0,
            z: cam ? cam.apex.z : 0,
          };
          const prev = j.stops[j.stops.length - 1];
          j.stops.push(stop);
          if (!prev || !cam) return;
          const dtS = (r.timestamp - prev.timestamp) / 1000;
          const g = Math.hypot(stop.x - prev.x, stop.z - prev.z);
          // Simultaneous or same-spot reads aren't a transit; skip the segment.
          if (dtS < FUSION_CONCURRENT_S || g < 1) return;
          const kmh = (g / dtS) * 3.6;
          j.segments.push({
            from: prev.cameraId,
            to: r.cameraId,
            distanceM: g,
            dtS,
            impliedKmh: kmh,
          });
          if (kmh > FUSION_MAX_IMPLIED_KPH) {
            j.alerts.push({ type: 'jump', from: prev.cameraId, to: r.cameraId, impliedKmh: kmh });
          }
        }

        function fusionSnapshot() {
          const sigs = sightingsRef.current;
          const list = [...journeys.values()]
            .map((j) => ({
              plate: j.plate,
              stops: j.stops.length,
              cams: new Set(j.stops.map((s) => s.cameraId)).size,
              chain: j.stops.map((s) => s.cameraId),
              segments: j.segments.map((s) => ({ from: s.from, to: s.to, kmh: s.impliedKmh })),
              jump: j.alerts.some((a) => a.type === 'jump'),
            }))
            .sort((a, b) => b.stops - a.stops)
            .slice(0, FUSION_MAX_LISTED);
          return {
            total: sigs.length,
            anon: anonCount,
            firstAt: sigs.length ? sigs[0].timestamp : null,
            lastAt: sigs.length ? sigs[sigs.length - 1].timestamp : null,
            journeys: list,
          };
        }

        function selectJourney(plate) {
          if (journeyLine) {
            journeyGroup.remove(journeyLine);
            journeyLine.geometry.dispose();
            journeyLine.material.dispose();
            journeyLine = null;
          }
          const j = journeys.get(plate);
          if (!j || j.stops.length < 2) return;
          const pts = [];
          let lastCam = null;
          for (const s of j.stops) {
            if (s.cameraId === lastCam) continue;
            lastCam = s.cameraId;
            pts.push(new THREE.Vector3(s.x, 0.9, s.z));
          }
          if (pts.length < 2) return;
          const geo = new THREE.BufferGeometry().setFromPoints(pts);
          const mat = new THREE.LineBasicMaterial({ color: 0x00e5ff });
          journeyLine = new THREE.Line(geo, mat);
          journeyGroup.add(journeyLine);
        }

        function resetFusion() {
          if (journeyLine) {
            journeyGroup.remove(journeyLine);
            journeyLine.geometry.dispose();
            journeyLine.material.dispose();
            journeyLine = null;
          }
          journeys.clear();
          anonCount = 0;
          sightingsRef.current = [];
        }

        fusionApiRef.current = {
          getSnapshot: fusionSnapshot,
          selectJourney,
          reset: resetFusion,
        };

        // Every frame: find vehicles inside each camera's FOV. On first entry
        // emit a sighting record, attach the bounding box + label; when a
        // vehicle leaves all cones its overlay is torn down (the sighting
        // record itself stays for the fusion phase).
        function updateDetections() {
          if (cameraData.length === 0 || vehicles.length === 0) {
            for (const id of [...activeSightings.keys()]) tearDownSighting(id);
            return;
          }
          const now = Date.now();
          const inCone = new Map();
          for (const v of vehicles) {
            const pos = v.mesh.position;
            for (let ci = 0; ci < cameraData.length; ci++) {
              const cam = cameraData[ci];
              if (!pointInFov(pos, cam)) continue;
              if (!inCone.has(ci)) inCone.set(ci, new Set());
              inCone.get(ci).add(v.id);
              if (!activeSightings.has(v.id)) {
                const confidence = 88 + Math.random() * 11.9;
                const record = {
                  vehicleId: v.id,
                  plateNumber: v.plate,
                  cameraId: cam.id,
                  timestamp: now,
                  speed: Math.round(v.speed * 3.6),
                  vehicleType: 'car',
                  color: '#ff2020',
                  confidence: +confidence.toFixed(1),
                };
                sightingsRef.current.push(record);
                fuseSighting(record);
                activeSightings.set(v.id, {
                  confidence,
                  overlay: createDetectionOverlay(!v.plate),
                });
                v.mesh.add(activeSightings.get(v.id).overlay.box);
                console.log(
                  `sighting: ${cam.id} -> ${v.plate ?? 'NO PLATE'} ` +
                    `${confidence.toFixed(1)}% ${Math.round(v.speed * 3.6)} km/h`
                );
              }
            }
          }
          for (const id of [...activeSightings.keys()]) {
            let still = false;
            for (const set of inCone.values()) {
              if (set.has(id)) {
                still = true;
                break;
              }
            }
            if (!still) tearDownSighting(id);
          }
        }

        // Create a vehicle mesh on a given road at a given curve parameter,
        // heading either direction. Returns the vehicle record; callers decide
        // whether to push it into the active list (and enforce the cap).
        function createVehicle(si, curveT, dir) {
          const mesh = createVehicleMesh();
          const travelT = dir === 1 ? curveT : 1 - curveT;
          const start = vehiclePosition({ si, dir, t: travelT }, roadSegments[si]);
          mesh.position.copy(start.pos);
          mesh.rotation.y = Math.atan2(start.dir.x, start.dir.z);
          vehiclesGroup.add(mesh);
          return {
            id: nextVehicleId++,
            mesh,
            si,
            dir,
            t: travelT,
            speed: (VEHICLE_KPH_MIN + Math.random() * (VEHICLE_KPH_MAX - VEHICLE_KPH_MIN)) / 3.6,
            plate: generatePlate(),
            track: { type: 'car', color: '#ff2020' },
            age: 0,
          };
        }

        function selectVehicle(v) {
          selectedVehicle = v;
          labelEl.style.display = 'block';
        }

        function deselectVehicle() {
          selectedVehicle = null;
          labelEl.style.display = 'none';
        }

        clearVehiclesRef.current = () => {
          deselectVehicle();
          resetFusion();
          for (const id of [...activeSightings.keys()]) tearDownSighting(id);
          for (let i = vehicles.length - 1; i >= 0; i--) {
            vehiclesGroup.remove(vehicles[i].mesh);
          }
          vehicles.length = 0;
        };

        // Parametric t on a curve nearest to a world-space point: a coarse
        // pass, then a fine pass around the best coarse hit.
        function nearestTOnCurve(curve, point, coarse) {
          let bestT = 0;
          let bestD = Infinity;
          for (let i = 0; i <= coarse; i++) {
            const t = i / coarse;
            const p = curve.getPoint(t);
            const d = Math.hypot(p.x - point.x, p.z - point.z);
            if (d < bestD) {
              bestD = d;
              bestT = t;
            }
          }
          const step = 1 / coarse;
          const lo = Math.max(0, bestT - step);
          const hi = Math.min(1, bestT + step);
          for (let i = 0; i <= 40; i++) {
            const t = lo + ((hi - lo) * i) / 40;
            const p = curve.getPoint(t);
            const d = Math.hypot(p.x - point.x, p.z - point.z);
            if (d < bestD) {
              bestD = d;
              bestT = t;
            }
          }
          return { t: bestT, d: bestD };
        }

        function nearestRoadSegment(point, maxDist) {
          let best = null;
          let bestD = Infinity;
          for (let si = 0; si < roadSegments.length; si++) {
            const { d } = nearestTOnCurve(roadSegments[si].curve, point, 40);
            if (d < bestD) {
              bestD = d;
              best = si;
            }
          }
          if (best == null || bestD > maxDist) return null;
          return best;
        }

        // Click-to-spawn: nearest drivable road to the (already raycast) hit
        // point, start there in a random direction, honor the vehicle cap.
        // Returns true when a vehicle was spawned.
        function spawnAtPoint(point, maxDist) {
          if (vehicles.length >= VEHICLE_MAX) return false;
          const si = nearestRoadSegment(point, maxDist);
          if (si == null) return false;
          const { t } = nearestTOnCurve(roadSegments[si].curve, point, 120);
          const v = createVehicle(si, t, Math.random() < 0.5 ? 1 : -1);
          vehicles.push(v);
          return true;
        }

        const raycaster = new THREE.Raycaster();
        raycaster.params.Line.threshold = 3;
        let downX = 0;
        let downY = 0;

        function handleClick(e) {
          const rect = container.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / container.clientWidth) * 2 - 1,
            -((e.clientY - rect.top) / container.clientHeight) * 2 + 1
          );
          raycaster.setFromCamera(ndc, camera);

          // Left click only spawns: clicking a car does nothing (never spawn
          // on the road underneath it); a click on a road spawns a vehicle.
          // Tube hits are on a drivable road already; thin-line hits may be on
          // a non-drivable highway, so fall back to the nearest drivable road.
          const vehicleHits = vehiclesGroup.visible
            ? raycaster.intersectObjects(vehiclesGroup.children, false)
            : [];
          if (vehicleHits.length > 0) return;

          deselectVehicle();
          const roadHits = raycaster.intersectObjects(
            [...roadGroupCurrent.children, ...roadGroup.children],
            false
          );
          for (const h of roadHits) {
            const maxDist = h.object.parent === roadGroupCurrent
              ? CLICK_SPAWN_MAX_DIST
              : ROAD_CLICK_LOOSE_DIST;
            if (spawnAtPoint(h.point, maxDist)) break;
          }
        }

        // Right click selects/deselects the vehicle under the cursor to show
        // its live speed label. Never spawns, so it can't interfere with the
        // left-click spawn.
        function handleRightClick(e) {
          const rect = container.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / container.clientWidth) * 2 - 1,
            -((e.clientY - rect.top) / container.clientHeight) * 2 + 1
          );
          raycaster.setFromCamera(ndc, camera);

          const vehicleHits = vehiclesGroup.visible
            ? raycaster.intersectObjects(vehiclesGroup.children, false)
            : [];
          if (vehicleHits.length > 0) {
            const hit = vehicles.find((v) => v.mesh === vehicleHits[0].object);
            if (hit) {
              if (selectedVehicle === hit) deselectVehicle();
              else selectVehicle(hit);
              return;
            }
          }
          deselectVehicle();
        }

        function onPointerDown(e) {
          downX = e.clientX;
          downY = e.clientY;
        }

        function onPointerUp(e) {
          const dx = e.clientX - downX;
          const dy = e.clientY - downY;
          if (dx * dx + dy * dy < 25) {
            if (e.button === 2) handleRightClick(e);
            else if (e.button === 0) handleClick(e);
          }
        }

        function onContextMenu(e) {
          e.preventDefault();
        }

        // Hover a ground camera to reveal its CAM-xx label.
        function onPointerMove(e) {
          if (!cameraGroup.visible) {
            hoveredCamera = null;
            return;
          }
          const rect = container.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / container.clientWidth) * 2 - 1,
            -((e.clientY - rect.top) / container.clientHeight) * 2 + 1
          );
          raycaster.setFromCamera(ndc, camera);
          const hits = raycaster.intersectObjects(cameraGroup.children, true);
          hoveredCamera = hits.length > 0
            ? cameraGroup.children.indexOf(hits[0].object.parent)
            : null;
          if (hoveredCamera === -1) hoveredCamera = null;
        }

        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('contextmenu', onContextMenu);
        renderer.domElement.addEventListener('pointermove', onPointerMove);

        function animate() {
          animId = requestAnimationFrame(animate);
          const now = performance.now();
          const dt = Math.min((now - prevT) / 1000, 0.1);
          prevT = now;

          for (let i = vehicles.length - 1; i >= 0; i--) {
            const v = vehicles[i];
            if (advanceVehicle(v, roadSegments, junctions, dt, VEHICLE_MAX_AGE_S)) {
              tearDownSighting(v.id);
              vehiclesGroup.remove(v.mesh);
              vehicles.splice(i, 1);
            } else {
              const { pos, dir } = vehiclePosition(v, roadSegments[v.si]);
              v.mesh.position.copy(pos);
              v.mesh.rotation.y = Math.atan2(dir.x, dir.z);
            }
          }

          updateDetections();

          // Pin each active detection's plate/confidence/speed label above its
          // bounding box, honoring the Detection Overlay toggle + Vehicles toggle.
          const overlaysShown = detectionOverlayOn.value && vehiclesGroup.visible;
          for (const [id, s] of activeSightings) {
            const v = vehicles.find((veh) => veh.id === id);
            if (!v) {
              tearDownSighting(id);
              continue;
            }
            s.overlay.box.visible = overlaysShown;
            const el = s.overlay.el;
            el.style.display = overlaysShown ? 'block' : 'none';
            if (!overlaysShown) continue;
            const anchor = v.mesh.position.clone();
            anchor.y += 4.6;
            const proj = anchor.project(camera);
            if (proj.z >= 1) {
              el.style.display = 'none';
              continue;
            }
            el.style.left = `${((proj.x * 0.5 + 0.5) * container.clientWidth).toFixed(1)}px`;
            el.style.top = `${((-proj.y * 0.5 + 0.5) * container.clientHeight).toFixed(1)}px`;
            el.textContent = v.plate
              ? `${v.plate}  ${s.confidence.toFixed(1)}% · ${Math.round(v.speed * 3.6)} km/h`
              : `NO PLATE DETECTED  ${s.confidence.toFixed(1)}% · ${Math.round(v.speed * 3.6)} km/h`;
          }

          // Keep the selected vehicle's speed label pinned above it.
          if (selectedVehicle) {
            const idx = vehicles.indexOf(selectedVehicle);
            if (idx === -1 || !vehiclesGroup.visible) {
              deselectVehicle();
            } else {
              const anchor = selectedVehicle.mesh.position.clone();
              anchor.y += 4.2;
              const proj = anchor.project(camera);
              if (proj.z < 1) {
                const sx = (proj.x * 0.5 + 0.5) * container.clientWidth;
                const sy = (-proj.y * 0.5 + 0.5) * container.clientHeight;
                labelEl.style.display = 'block';
                labelEl.style.left = `${sx.toFixed(1)}px`;
                labelEl.style.top = `${sy.toFixed(1)}px`;
                labelEl.textContent = `${Math.round(selectedVehicle.speed * 3.6)} km/h`;
              } else {
                labelEl.style.display = 'none';
              }
            }
          }

          // Pin camera labels above their cameras (only when hovered).
          cameraGroup.children.forEach((cam, i) => {
            const el = cameraLabels[i];
            const shown = hoveredCamera === i && cameraGroup.visible;
            el.style.display = shown ? 'block' : 'none';
            if (!shown) return;
            const anchor = cam.position.clone();
            anchor.y += CAM_POLE_HEIGHT + 1;
            const proj = anchor.project(camera);
            if (proj.z >= 1) {
              el.style.display = 'none';
              return;
            }
            el.style.left = `${((proj.x * 0.5 + 0.5) * container.clientWidth).toFixed(1)}px`;
            el.style.top = `${((-proj.y * 0.5 + 0.5) * container.clientHeight).toFixed(1)}px`;
          });

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

        return () => {
          window.removeEventListener('resize', onResize);
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          renderer.domElement.removeEventListener('pointerup', onPointerUp);
          renderer.domElement.removeEventListener('contextmenu', onContextMenu);
          renderer.domElement.removeEventListener('pointermove', onPointerMove);
          labelEl.remove();
          cameraLabels.forEach((el) => el.remove());
          for (const id of [...activeSightings.keys()]) tearDownSighting(id);
        };
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
      if (renderer?.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, []);

  // Refresh the fusion panel from the engine (lives in the init closure) at 1Hz.
  useEffect(() => {
    const id = setInterval(() => {
      setFusionSnap(fusionApiRef.current?.getSnapshot() ?? null);
    }, 1000);
    return () => clearInterval(id);
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
          <span className="sep">|</span>
          <span>{stats.cameras} cameras</span>
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
          <button
            type="button"
            className="clear-button"
            onClick={() => clearVehiclesRef.current?.()}
          >
            Clear vehicles
          </button>
          <div className="fusion-panel">
            <h3 className="fusion-title">ANPR Fusion</h3>
            {fusionSnap ? (
              <>
                <p className="fusion-meta">
                  {fusionSnap.total} sightings &middot; {fusionSnap.anon} anonymous
                </p>
                {fusionSnap.journeys.length === 0 && (
                  <p className="fusion-empty">No matched journeys yet.</p>
                )}
                <ul className="journey-list">
                  {fusionSnap.journeys.map((j) => (
                    <li
                      key={j.plate}
                      className="journey-row"
                      onClick={() => fusionApiRef.current?.selectJourney(j.plate)}
                    >
                      <div className="journey-head">
                        <span className="journey-plate">{j.plate}</span>
                        <span className="journey-badge">
                          {j.cams} cam{j.cams === 1 ? '' : 's'}
                        </span>
                        {j.jump && <span className="journey-badge alert">jump</span>}
                      </div>
                      <div className="journey-chain">{j.chain.join(' → ')}</div>
                      {j.segments.length > 0 && (
                        <div className="journey-segments">
                          {j.segments.map((s, k) => (
                            <span
                              key={k}
                              className={`seg${s.kmh > FUSION_MAX_IMPLIED_KPH ? ' seg-jump' : ''}`}
                            >
                              {s.from}&rarr;{s.to} {Math.round(s.kmh)} km/h
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {fusionSnap.journeys.length > 0 && (
                  <div className="journey-tip">Click a journey to trace its camera path.</div>
                )}
                <button
                  type="button"
                  className="fusion-reset"
                  onClick={() => fusionApiRef.current?.reset()}
                >
                  Reset ANPR data
                </button>
              </>
            ) : (
              <p className="fusion-empty">Waiting for sightings&hellip;</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
