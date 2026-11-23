/**
 * A small, dependency-free reader for the glTF binary (.glb) subset the bundled character model uses: one or more triangle
 * primitives with float POSITION / NORMAL / TEXCOORD_0 and 16/32-bit indices, placed by node matrices or TRS. It is pure (no DOM,
 * no Three.js) so the pose engine and its tests can load the model directly. Anything else (skins, morph targets, sparse
 * accessors, compressed meshes) is rejected with a clear error rather than half-read.
 */
export interface GlbMesh {
  /** World-space vertex data (all node transforms applied), in the file's units (metres). */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Copyright and credit information from `asset.extras`, if the file carries any. */
  credit: { title?: string; author?: string; license?: string; source?: string };
  hasSkin: boolean;
}

interface GltfJson {
  asset?: { extras?: Record<string, unknown> };
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; skin?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number; targets?: unknown[] }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; sparse?: unknown; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  skins?: unknown[];
}

type Mat = number[]; // 16, column-major (glTF)

const mul = (a: Mat, b: Mat): Mat => {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
const identity = (): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat {
  const [x, y, z, w] = q as [number, number, number, number];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0]!, 2 * (xy + wz) * s[0]!, 2 * (xz - wy) * s[0]!, 0,
    2 * (xy - wz) * s[1]!, (1 - 2 * (xx + zz)) * s[1]!, 2 * (yz + wx) * s[1]!, 0,
    2 * (xz + wy) * s[2]!, 2 * (yz - wx) * s[2]!, (1 - 2 * (xx + yy)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

const COMPONENT: Record<number, { size: number; read: (dv: DataView, o: number) => number }> = {
  5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true) },
  5125: { size: 4, read: (dv, o) => dv.getUint32(o, true) },
  5123: { size: 2, read: (dv, o) => dv.getUint16(o, true) },
  5121: { size: 1, read: (dv, o) => dv.getUint8(o) },
};
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function parseGlb(bytes: Uint8Array): GlbMesh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a binary glTF (.glb) file.');
  if (dv.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 is supported.');
  let json: GltfJson | null = null;
  let bin: { start: number; length: number } | null = null;
  for (let off = 12; off + 8 <= bytes.byteLength; ) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes.subarray(off + 8, off + 8 + len))) as GltfJson;
    else if (type === 0x004e4942 && !bin) bin = { start: bytes.byteOffset + off + 8, length: len };
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error('The .glb has no JSON or binary chunk.');
  if (json.extensionsRequired?.length) throw new Error(`Unsupported glTF extensions: ${json.extensionsRequired.join(', ')}`);

  const binView = new DataView(bytes.buffer, bin.start, bin.length);
  const accessor = (index: number): { n: number; data: number[] } => {
    const a = json!.accessors?.[index];
    if (!a || a.sparse || a.bufferView === undefined) throw new Error('Unsupported accessor (sparse or without data).');
    const bv = json!.bufferViews![a.bufferView]!;
    const comp = COMPONENT[a.componentType];
    const n = TYPE_COUNT[a.type];
    if (!comp || !n) throw new Error('Unsupported accessor type.');
    const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : comp.size * n;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const data = new Array<number>(a.count * n);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) data[i * n + c] = comp.read(binView, base + i * stride + c * comp.size);
    return { n, data };
  };

  const nodes = json.nodes ?? [];
  const posOut: number[] = [];
  const norOut: number[] = [];
  const uvOut: number[] = [];
  const idxOut: number[] = [];
  let hasSkin = false;

  const visit = (ni: number, parent: Mat): void => {
    const node = nodes[ni];
    if (!node) return;
    const local = node.matrix && node.matrix.length === 16 ? node.matrix : trs(node.translation, node.rotation, node.scale);
    const world = mul(parent, local);
    if (node.skin !== undefined) hasSkin = true;
    if (node.mesh !== undefined) {
      for (const prim of json!.meshes![node.mesh]!.primitives) {
        if ((prim.mode ?? 4) !== 4) throw new Error('Only triangle meshes are supported.');
        if (prim.targets?.length) throw new Error('Morph targets are not supported.');
        const pa = accessor(prim.attributes.POSITION!);
        const na = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL) : null;
        const ua = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0) : null;
        const count = pa.data.length / 3;
        const base = posOut.length / 3;
        for (let i = 0; i < count; i++) {
          const x = pa.data[i * 3]!, y = pa.data[i * 3 + 1]!, z = pa.data[i * 3 + 2]!;
          posOut.push(
            world[0]! * x + world[4]! * y + world[8]! * z + world[12]!,
            world[1]! * x + world[5]! * y + world[9]! * z + world[13]!,
            world[2]! * x + world[6]! * y + world[10]! * z + world[14]!,
          );
          if (na) {
            const nx = na.data[i * 3]!, ny = na.data[i * 3 + 1]!, nz = na.data[i * 3 + 2]!;
            const wx = world[0]! * nx + world[4]! * ny + world[8]! * nz;
            const wy = world[1]! * nx + world[5]! * ny + world[9]! * nz;
            const wz = world[2]! * nx + world[6]! * ny + world[10]! * nz;
            const l = Math.hypot(wx, wy, wz) || 1;
            norOut.push(wx / l, wy / l, wz / l);
          } else norOut.push(0, 1, 0);
          uvOut.push(ua ? ua.data[i * 2]! : 0, ua ? ua.data[i * 2 + 1]! : 0);
        }
        if (prim.indices === undefined) for (let i = 0; i < count; i++) idxOut.push(base + i);
        else for (const v of accessor(prim.indices).data) idxOut.push(base + v);
      }
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? []) visit(root, identity());
  if (!posOut.length) throw new Error('The .glb contains no mesh.');
  const extras = (json.asset?.extras ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof extras[k] === 'string' ? (extras[k] as string) : undefined);
  return {
    positions: new Float32Array(posOut),
    normals: new Float32Array(norOut),
    uvs: new Float32Array(uvOut),
    indices: new Uint32Array(idxOut),
    credit: { title: str('title'), author: str('author'), license: str('license'), source: str('source') },
    hasSkin,
  };
}
