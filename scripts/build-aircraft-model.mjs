/**
 * Generates the airliner model at public/models/airliner.glb.
 *
 * Cesium ships no aircraft model, and pulling a third-party GLB into the repo
 * means inheriting its licence and its polygon count. Generating one gives us
 * a model that is a few kilobytes, unambiguously ours, and shaped exactly for
 * how it gets viewed here: mostly from a few hundred metres away, in
 * silhouette against terrain.
 *
 * Conventions, which the renderer depends on:
 *   +X  nose (forward)
 *   +Y  up            (glTF is Y-up; Cesium rotates this to its own Z-up)
 *   +Z  starboard wing
 *
 * Run with `npm run build-model`. The output is committed, so this only needs
 * re-running when the shape changes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(root, "public", "models", "airliner.glb");

// --- geometry primitives ----------------------------------------------------

/** An accumulating mesh: positions, normals and triangle indices. */
function createMesh() {
  return { positions: [], normals: [], indices: [] };
}

/** Add one triangle, computing its face normal. */
function addTriangle(mesh, a, b, c) {
  const base = mesh.positions.length / 3;

  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;

  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;

  for (const vertex of [a, b, c]) {
    mesh.positions.push(vertex[0], vertex[1], vertex[2]);
    mesh.normals.push(nx, ny, nz);
  }
  mesh.indices.push(base, base + 1, base + 2);
}

/** Add a quad as two triangles, wound consistently. */
function addQuad(mesh, a, b, c, d) {
  addTriangle(mesh, a, b, c);
  addTriangle(mesh, a, c, d);
}

/**
 * A surface of revolution about the X axis.
 *
 * `profile` is a list of [x, radius] pairs from tail to nose. Used for the
 * fuselage and the engine nacelles.
 */
function addRevolution(mesh, profile, segments = 16) {
  for (let i = 0; i < profile.length - 1; i += 1) {
    const [x0, r0] = profile[i];
    const [x1, r1] = profile[i + 1];

    for (let s = 0; s < segments; s += 1) {
      const t0 = (s / segments) * Math.PI * 2;
      const t1 = ((s + 1) / segments) * Math.PI * 2;

      const p00 = [x0, Math.sin(t0) * r0, Math.cos(t0) * r0];
      const p01 = [x0, Math.sin(t1) * r0, Math.cos(t1) * r0];
      const p10 = [x1, Math.sin(t0) * r1, Math.cos(t0) * r1];
      const p11 = [x1, Math.sin(t1) * r1, Math.cos(t1) * r1];

      // Degenerate rings (a closed nose or tail) collapse to a triangle.
      if (r0 < 1e-6) {
        addTriangle(mesh, [x0, 0, 0], p11, p10);
      } else if (r1 < 1e-6) {
        addTriangle(mesh, p00, p01, [x1, 0, 0]);
      } else {
        addQuad(mesh, p00, p01, p11, p10);
      }
    }
  }
}

/**
 * A tapered, swept aerofoil plate.
 *
 * Built as a closed solid so it reads correctly from below as well as above.
 * `mirror` flips it across the centreline for the opposite wing.
 */
function addWing(mesh, options) {
  const {
    rootX,
    rootChord,
    tipChord,
    span,
    sweep,
    thickness,
    dihedral = 0,
    axis = "z",
    mirror = false,
  } = options;

  const sign = mirror ? -1 : 1;

  // Four planform corners: root leading/trailing, tip leading/trailing.
  const rootLeading = rootX + rootChord / 2;
  const rootTrailing = rootX - rootChord / 2;
  const tipLeading = rootX + rootChord / 2 - sweep;
  const tipTrailing = tipLeading - tipChord;

  const lateral = (value) => (axis === "z" ? value * sign : 0);
  const vertical = (value) => (axis === "y" ? value * sign : 0);

  const rise = dihedral * span;

  /** Build a point from chordwise x, spanwise distance and vertical offset. */
  const point = (x, spanwise, up) => {
    const lift = axis === "z" ? (spanwise / span) * rise : 0;
    return [
      x,
      vertical(spanwise) + up + lift,
      lateral(spanwise),
    ];
  };

  const half = thickness / 2;

  const rlTop = point(rootLeading, 0, half);
  const rtTop = point(rootTrailing, 0, half);
  const tlTop = point(tipLeading, span, half * 0.4);
  const ttTop = point(tipTrailing, span, half * 0.4);

  const rlBottom = point(rootLeading, 0, -half);
  const rtBottom = point(rootTrailing, 0, -half);
  const tlBottom = point(tipLeading, span, -half * 0.4);
  const ttBottom = point(tipTrailing, span, -half * 0.4);

  // Winding is flipped on the mirrored side so normals still face outward.
  const quad = (a, b, c, d) =>
    mirror ? addQuad(mesh, a, d, c, b) : addQuad(mesh, a, b, c, d);

  quad(rlTop, tlTop, ttTop, rtTop); // upper surface
  quad(rlBottom, rtBottom, ttBottom, tlBottom); // lower surface
  quad(rlTop, rlBottom, tlBottom, tlTop); // leading edge
  quad(rtTop, ttTop, ttBottom, rtBottom); // trailing edge
  quad(tlTop, tlBottom, ttBottom, ttTop); // tip cap
}

// --- the aircraft -----------------------------------------------------------

/**
 * Proportions of a twin-engine narrowbody, normalised to a length of 1.
 *
 * Scaled to real metres by the renderer.
 */
function buildAircraft() {
  const body = createMesh();
  const wings = createMesh();
  const engines = createMesh();

  // Fuselage: pointed nose, constant cabin, tapering to an upswept tail.
  addRevolution(
    body,
    [
      [-0.50, 0.0],
      [-0.44, 0.018],
      [-0.34, 0.032],
      [-0.20, 0.040],
      [0.10, 0.042],
      [0.30, 0.040],
      [0.42, 0.030],
      [0.48, 0.014],
      [0.50, 0.0],
    ],
    18,
  );

  // Main wings, swept back with a little dihedral.
  for (const mirror of [false, true]) {
    addWing(wings, {
      rootX: -0.02,
      rootChord: 0.22,
      tipChord: 0.075,
      span: 0.46,
      sweep: 0.16,
      thickness: 0.022,
      dihedral: 0.06,
      axis: "z",
      mirror,
    });
  }

  // Horizontal stabilisers.
  for (const mirror of [false, true]) {
    addWing(wings, {
      rootX: -0.40,
      rootChord: 0.10,
      tipChord: 0.04,
      span: 0.17,
      sweep: 0.07,
      thickness: 0.012,
      dihedral: 0.05,
      axis: "z",
      mirror,
    });
  }

  // Vertical fin: the same aerofoil built on the vertical axis.
  addWing(wings, {
    rootX: -0.40,
    rootChord: 0.14,
    tipChord: 0.055,
    span: 0.15,
    sweep: 0.09,
    thickness: 0.012,
    axis: "y",
    mirror: false,
  });

  // Underwing engines, with a short pylon joining each to the wing.
  for (const side of [1, -1]) {
    const z = side * 0.17;
    const y = -0.045;

    const nacelle = createMesh();
    addRevolution(
      nacelle,
      [
        [-0.055, 0.0],
        [-0.045, 0.020],
        [0.020, 0.024],
        [0.045, 0.022],
        [0.055, 0.016],
      ],
      12,
    );

    // Offset the nacelle into position under the wing.
    for (let i = 0; i < nacelle.positions.length; i += 3) {
      nacelle.positions[i] += 0.03;
      nacelle.positions[i + 1] += y;
      nacelle.positions[i + 2] += z;
    }
    mergeMesh(engines, nacelle);

    // Pylon.
    const pylon = createMesh();
    addWing(pylon, {
      rootX: 0.01,
      rootChord: 0.09,
      tipChord: 0.07,
      span: 0.045,
      sweep: 0.01,
      thickness: 0.008,
      axis: "y",
      mirror: false,
    });
    for (let i = 0; i < pylon.positions.length; i += 3) {
      pylon.positions[i + 1] += y;
      pylon.positions[i + 2] += z;
    }
    mergeMesh(engines, pylon);
  }

  return { body, wings, engines };
}

function mergeMesh(target, source) {
  const offset = target.positions.length / 3;
  target.positions.push(...source.positions);
  target.normals.push(...source.normals);
  for (const index of source.indices) target.indices.push(index + offset);
}

// --- glTF assembly ----------------------------------------------------------

function align4(value) {
  return (value + 3) & ~3;
}

/**
 * Pack the meshes into a .glb.
 *
 * One binary buffer holds every accessor back to back; the JSON chunk
 * describes where each one starts.
 */
function buildGlb(parts) {
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  let offset = 0;

  const pushView = (data, target) => {
    const bytes = Buffer.from(
      data instanceof Float32Array ? data.buffer : data.buffer,
    );
    const padded = align4(bytes.length);
    const view = Buffer.alloc(padded);
    bytes.copy(view);

    buffers.push(view);
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
      target,
    });
    offset += padded;
    return bufferViews.length - 1;
  };

  const materials = [
    // Fuselage: near-white, slightly glossy.
    {
      name: "fuselage",
      pbrMetallicRoughness: {
        baseColorFactor: [0.93, 0.95, 0.98, 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.45,
      },
    },
    // Wings: a shade darker so they read against the body from above.
    {
      name: "wing",
      pbrMetallicRoughness: {
        baseColorFactor: [0.72, 0.77, 0.85, 1],
        metallicFactor: 0.2,
        roughnessFactor: 0.5,
      },
    },
    // Engines: dark, so they read as mass at small sizes.
    {
      name: "engine",
      pbrMetallicRoughness: {
        baseColorFactor: [0.24, 0.27, 0.33, 1],
        metallicFactor: 0.35,
        roughnessFactor: 0.6,
      },
    },
  ];

  parts.forEach((part, index) => {
    const positions = new Float32Array(part.mesh.positions);
    const normals = new Float32Array(part.mesh.normals);
    const indices = new Uint32Array(part.mesh.indices);

    // ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963
    const positionView = pushView(positions, 34962);
    const normalView = pushView(normals, 34962);
    const indexView = pushView(indices, 34963);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], positions[i + axis]);
        max[axis] = Math.max(max[axis], positions[i + axis]);
      }
    }

    // 5126 = FLOAT, 5125 = UNSIGNED_INT
    accessors.push(
      {
        bufferView: positionView,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
        min,
        max,
      },
      {
        bufferView: normalView,
        componentType: 5126,
        count: normals.length / 3,
        type: "VEC3",
      },
      {
        bufferView: indexView,
        componentType: 5125,
        count: indices.length,
        type: "SCALAR",
      },
    );

    const base = index * 3;
    meshes.push({
      name: part.name,
      primitives: [
        {
          attributes: { POSITION: base, NORMAL: base + 1 },
          indices: base + 2,
          material: part.material,
        },
      ],
    });
    nodes.push({ mesh: index, name: part.name });
  });

  const binary = Buffer.concat(buffers);

  const gltf = {
    asset: {
      version: "2.0",
      generator: "Flightscape aircraft generator",
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };

  const jsonText = JSON.stringify(gltf);
  const jsonBuffer = Buffer.alloc(align4(Buffer.byteLength(jsonText)), 0x20);
  jsonBuffer.write(jsonText, "utf8");

  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuffer.length + 8 + binary.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuffer.length, 0);
  jsonHeader.write("JSON", 4, "ascii");

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.write("BIN\0", 4, "ascii");

  return Buffer.concat([header, jsonHeader, jsonBuffer, binHeader, binary]);
}

// --- entry point ------------------------------------------------------------

const { body, wings, engines } = buildAircraft();

const glb = buildGlb([
  { name: "fuselage", mesh: body, material: 0 },
  { name: "wings", mesh: wings, material: 1 },
  { name: "engines", mesh: engines, material: 2 },
]);

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, glb);

const triangles =
  (body.indices.length + wings.indices.length + engines.indices.length) / 3;
console.log(
  `[model] wrote ${OUTPUT} (${(glb.length / 1024).toFixed(1)} kB, ${triangles} triangles)`,
);
