class Miner {
  constructor(blockData, target, prevBlockHash) {
    this.blockData = blockData;
    this.target = target;
    this.prevBlockHash = prevBlockHash;
    this.initialized = false;
    this.device = undefined;
  }

  async initialize() {
    if (this.initialized) return console.error("Model already initialized");
    if (!navigator.gpu) throw new Error("WebGPU is not supported");

    const adapter = await navigator.gpu.requestAdapter();
    this.device = await adapter.requestDevice();

    this.initBindGroups();
    this.initPipelines();

    const secondBlock = "000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd";
    const recentBlock = "0000000000000000000376eae121bc432f7337a6de4adc00c7986466ef4b9a48";

    await this.loadBlock(secondBlock);

    this.initialized = true;
  }

  prepareBlockHeader(blockTemplate) {
    // Convert block template data into a Uint8Array
    const blockHeaderBuffer = new ArrayBuffer(80);
    const blockHeaderView = new DataView(blockHeaderBuffer);

    blockHeaderView.setUint32(0, blockTemplate.version, true);
    for (let i = 0; i < 8; i++) {
      blockHeaderView.setUint32(4 + i * 4, parseInt(blockTemplate.previousblockhash.slice((7 - i) * 8, (8 - i) * 8), 16), true);
    }
    for (let i = 0; i < 8; i++) {
      blockHeaderView.setUint32(36 + i * 4, parseInt(blockTemplate.merkleroot.slice((7 - i) * 8, (8 - i) * 8), 16), true);
    }
    blockHeaderView.setUint32(68, blockTemplate.time, true);

    // Calculate the target using the .bits value
    // console.log("Bits: ", blockTemplate.bits);
    const bits = parseInt("0x" + blockTemplate.bits, 16);

    // 486604799;

    blockHeaderView.setUint32(72, "0x" + blockTemplate.bits, true);

    blockHeaderView.setUint32(76, blockTemplate.nonce, true);

    // Print as hex
    const blockHeaderHex = Array.from(new Uint8Array(blockHeaderBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    console.log("Block header: ", blockHeaderHex);

    return blockHeaderBuffer;
  }

  hexToUint32Array(hex) {
    console.log("hex", hex, typeof hex);
    const length = hex.length / 2;
    const buffer = new Uint8Array(length);

    for (let i = 0; i < length; i++) {
      buffer[i] = parseInt(hex.substr(i * 2, 2), 16);
    }

    // Convert Uint8Array to Uint32Array using the same ArrayBuffer
    const uint32Buffer = new Uint32Array(buffer.buffer);

    return uint32Buffer;
  }

  // This is all wrong (I need to sleep more), good reference: https://github.com/guerrerocarlos/bitcoin-miner/blob/master/index.js
  async loadBlock(hash) {
    if (this.initialized) {
      console.error("Miner already loaded");
      return;
    }

    // Pull from https://api.blockchair.com/bitcoin/raw/block/
    const blockJSON = await (await fetch(`https://api.blockchair.com/bitcoin/raw/block/${hash}`)).json();
    console.log("Block JSON: ", blockJSON);
    const data = blockJSON.data[hash];

    const blockHeaderBuffer = this.prepareBlockHeader(data.decoded_raw_block);

    // Calculate padding length
    const originalLength = 80;
    const totalLength = 128;

    // Create a new buffer for the padded block header
    const blockHeaderUint8ArrayPadded = new Uint8Array(totalLength);
    const blockHeaderUint8Array = new Uint8Array(blockHeaderBuffer);
    console.log(totalLength, blockHeaderUint8ArrayPadded.byteLength, blockHeaderUint8Array.byteLength);

    // Copy the original block header to the padded buffer
    blockHeaderUint8ArrayPadded.set(blockHeaderUint8Array, 0);

    // Append the '1' bit (0x80 byte)
    blockHeaderUint8ArrayPadded[originalLength] = 0x80;

    // Append the original message length as a 64-bit big-endian integer
    const originalLengthBits = BigInt(originalLength * 8);
    const highBits = Number(originalLengthBits >> 32n);
    const lowBits = Number(originalLengthBits & 0xffffffffn);

    const lengthBuffer = new ArrayBuffer(8);
    const lengthView = new DataView(lengthBuffer);
    lengthView.setUint32(0, highBits, false);
    lengthView.setUint32(4, lowBits, false);

    blockHeaderUint8ArrayPadded.set(new Uint8Array(lengthBuffer), totalLength - 8);

    // Convert the padded block header to a Uint32Array
    const blockHeaderUint32ArrayPadded = new Uint32Array(blockHeaderUint8ArrayPadded.buffer);

    console.log("Block header Uint32Array: ", new Uint32Array(blockHeaderBuffer), blockHeaderBuffer.byteLength);
    console.log("Block header Uint32Array padded: ", blockHeaderUint32ArrayPadded);

    this.hexBuffer = this.createBuffer(128, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.device.queue.writeBuffer(this.hexBuffer, 0, blockHeaderUint32ArrayPadded);

    console.log("Finished loading block.");
  }

  async run() {
    if (!this.initialized) return console.error("Run called before initialization.");

    const numThreads = 1;
    const nonceOffset = 0;
    const workgroup_X = 8;
    const outputBufferBytes = numThreads * 32;

    const commandEncoder = this.device.createCommandEncoder();

    const UniformBuffer = this.createBuffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const ResultBuffer = this.createBuffer(outputBufferBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC); // 256 bit output or 32 bytes
    const BindGroup = this.createBindGroup(this.u_s_BindLayout, [UniformBuffer, ResultBuffer]);
    this.device.queue.writeBuffer(UniformBuffer, 0, new Uint32Array([numThreads, nonceOffset]));

    const PassEncoder = commandEncoder.beginComputePass();
    PassEncoder.setPipeline(this.sha256Pipeline);
    PassEncoder.setBindGroup(0, BindGroup);
    PassEncoder.setBindGroup(1, this.createBindGroup(this.r_BindLayout, [this.hexBuffer]));
    PassEncoder.dispatchWorkgroups(workgroupCalc(numThreads, workgroup_X));
    PassEncoder.end();

    const resultOutputBuffer = this.createOutputBuffer(commandEncoder, ResultBuffer, outputBufferBytes);

    this.device.queue.submit([commandEncoder.finish()]);

    await resultOutputBuffer.mapAsync(GPUMapMode.READ);
    const output = resultOutputBuffer.getMappedRange();

    return uint32ArrayToHex(new Uint32Array(output));
  }

  initBindGroups() {
    this.r_BindLayout = this.createBindGroupLayout(["read-only-storage"]);
    this.u_s_BindLayout = this.createBindGroupLayout(["uniform", "storage"]);
  }

  initPipelines() {
    this.sha256Pipeline = this.createPipeline(sha256Shader, [this.u_s_BindLayout, this.r_BindLayout]);
  }

  createBindGroupLayout(string_entries) {
    const entries = string_entries.map((entry, i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: entry },
    }));
    return this.device.createBindGroupLayout({
      entries,
    });
  }

  createPipeline(shaderString, bindGroupLayouts) {
    const shaderModule = this.device.createShaderModule({
      code: shaderString,
    });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts,
    });
    const pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
    });
    return pipeline;
  }

  createBindGroup(bindGroupLayout, buffers) {
    const entries = buffers.map((buffer, i) => ({
      binding: i,
      resource: {
        buffer,
      },
    }));
    return this.device.createBindGroup({
      layout: bindGroupLayout,
      entries,
    });
  }

  createBuffer(size, usage) {
    return this.device.createBuffer({
      size: size,
      usage: usage,
    });
  }

  createOutputBuffer(commandEncoder, buffer, bytes) {
    const outputBuffer = this.createBuffer(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    commandEncoder.copyBufferToBuffer(buffer, 0, outputBuffer, 0, bytes);
    return outputBuffer;
  }
}

// Helper function to reverse the byte order (little-endian <-> big-endian)
function reverseEndian(hexString) {
  return hexString
    .match(/.{1,2}/g)
    .reverse()
    .join("");
}

function uint32ArrayToHex(array) {
  let hexStr = "";

  for (let i = 0; i < array.length; i++) {
    const chunk = array[i].toString(16).padStart(8, "0");
    hexStr += chunk;
  }

  return hexStr;
}

const workgroupCalc = (dim, size) => Math.min(Math.ceil(dim / size), 256);

async function hashHex(hexString) {
  const hexArray = hexString.match(/.{1,2}/g).map((byte) => parseInt(byte, 16));
  const uint8Array = new Uint8Array(hexArray);
  const hashBuffer = await crypto.subtle.digest("SHA-256", uint8Array);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((bytes) => bytes.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

// Some code referenced from https://github.com/MarcoCiaramella/sha256-gpu/blob/main/index.js
const sha256Shader = `
  fn swap_endianess32(val: u32) -> u32 {
      return ((val>>24u) & 0xffu) | ((val>>8u) & 0xff00u) | ((val<<8u) & 0xff0000u) | ((val<<24u) & 0xff000000u);
  }

  fn shw(x: u32, n: u32) -> u32 {
      return (x << (n & 31u)) & 0xffffffffu;
  }

  fn r(x: u32, n: u32) -> u32 {
      return (x >> n) | shw(x, 32u - n);
  }

  fn g0(x: u32) -> u32 {
      return r(x, 7u) ^ r(x, 18u) ^ (x >> 3u);
  }

  fn g1(x: u32) -> u32 {
      return r(x, 17u) ^ r(x, 19u) ^ (x >> 10u);
  }

  fn s0(x: u32) -> u32 {
      return r(x, 2u) ^ r(x, 13u) ^ r(x, 22u);
  }

  fn s1(x: u32) -> u32 {
      return r(x, 6u) ^ r(x, 11u) ^ r(x, 25u);
  }

  fn maj(a: u32, b: u32, c: u32) -> u32 {
      return (a & b) ^ (a & c) ^ (b & c);
  }

  fn ch(e: u32, f: u32, g: u32) -> u32 {
      return (e & f) ^ ((~e) & g);
  }


  struct Uniforms {
      numThreads: u32,
      nonceOffset: u32,
  };

  @group(1) @binding(0) var<storage, read> blockData: array<u32>;
  @group(0) @binding(0) var<uniform> params: Uniforms;
  @group(0) @binding(1) var<storage, read_write> hashes: array<u32>;

  @compute @workgroup_size(8)
  fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let numThreads: u32 = params.numThreads;
      let index = global_id.x;

      if (index >= numThreads) {
          return;
      }
      
      let hash_base_index = index * 8u;

      hashes[hash_base_index] = 0x6a09e667u;
      hashes[hash_base_index + 1] = 0xbb67ae85u;
      hashes[hash_base_index + 2] = 0x3c6ef372u;
      hashes[hash_base_index + 3] = 0xa54ff53au;
      hashes[hash_base_index + 4] = 0x510e527fu;
      hashes[hash_base_index + 5] = 0x9b05688cu;
      hashes[hash_base_index + 6] = 0x1f83d9abu;
      hashes[hash_base_index + 7] = 0x5be0cd19u;

      let k = array<u32,64>(
          0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
          0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
          0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
          0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
          0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
          0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
          0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
          0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
      );

      for (var i = 0u; i < 2; i++){
          let chunk_index = i * 16u;
          var w = array<u32,64>();
          for (var j = 0u; j < 16u; j++){
              w[j] = swap_endianess32(blockData[chunk_index + j]);
          }
          for (var j = 16u; j < 64u; j++){
              w[j] = w[j - 16u] + g0(w[j - 15u]) + w[j - 7u] + g1(w[j - 2u]);
          }
          var a = hashes[hash_base_index];
          var b = hashes[hash_base_index + 1];
          var c = hashes[hash_base_index + 2];
          var d = hashes[hash_base_index + 3];
          var e = hashes[hash_base_index + 4];
          var f = hashes[hash_base_index + 5];
          var g = hashes[hash_base_index + 6];
          var h = hashes[hash_base_index + 7];
          for (var j = 0u; j < 64u; j++){
              let t2 = s0(a) + maj(a, b, c);
              let t1 = h + s1(e) + ch(e, f, g) + k[j] + w[j];
              h = g;
              g = f;
              f = e;
              e = d + t1;
              d = c;
              c = b;
              b = a;
              a = t1 + t2;
          }
          hashes[hash_base_index] += a;
          hashes[hash_base_index + 1] += b;
          hashes[hash_base_index + 2] += c;
          hashes[hash_base_index + 3] += d;
          hashes[hash_base_index + 4] += e;
          hashes[hash_base_index + 5] += f;
          hashes[hash_base_index + 6] += g;
          hashes[hash_base_index + 7] += h;
      }
      hashes[hash_base_index] = swap_endianess32(hashes[hash_base_index]);
      hashes[hash_base_index + 1] = swap_endianess32(hashes[hash_base_index + 1]);
      hashes[hash_base_index + 2] = swap_endianess32(hashes[hash_base_index + 2]);
      hashes[hash_base_index + 3] = swap_endianess32(hashes[hash_base_index + 3]);
      hashes[hash_base_index + 4] = swap_endianess32(hashes[hash_base_index + 4]);
      hashes[hash_base_index + 5] = swap_endianess32(hashes[hash_base_index + 5]);
      hashes[hash_base_index + 6] = swap_endianess32(hashes[hash_base_index + 6]);
      hashes[hash_base_index + 7] = swap_endianess32(hashes[hash_base_index + 7]);
    }
`;

(async () => {
  const miner = new Miner();
  await miner.initialize();
  console.log("Result:", await miner.run());
})();
