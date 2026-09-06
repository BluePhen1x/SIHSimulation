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

function createRoadLine(coords) {
  const points = coords.map(([lon, lat]) => {
    const [x, z] = projectCoord(lon, lat);
    return new THREE.Vector3(x, 0.3, z);
  });
  if (points.length < 2) return null;

  const geom = new THREE.BufferGeometry().setFromPoints(points);
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

export default function App() {
  const containerRef = useRef(null);
  const [status, setStatus] = useState('Loading OpenStreetMap data...');
  const [stats, setStats] = useState(null);

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
            const line = createRoadLine(coords);
            if (line) {
              roadGroup.add(line);
              roadCount++;
            }
          }
        }

        scene.add(buildingGroup);
        scene.add(roadGroup);
        scene.add(createBlimpVisualization());

        setStats({ buildings: buildingCount, roads: roadCount });
        setStatus('Rendered');

        // TODO: Traffic simulation logic goes here

        function animate() {
          animId = requestAnimationFrame(animate);
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
    </div>
  );
}
