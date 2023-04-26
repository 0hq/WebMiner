const ONE_MB = 1024 * 1024;

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

    await this.loadBlock(recentBlock);

    this.initialized = true;
  }

  async loadBlock(hash) {
    if (this.initialized) {
      console.error("Miner already loaded");
      return;
    }

    // Pull from https://api.blockchair.com/bitcoin/raw/block/
    const blockJSON = await (await fetch(`https://api.blockchair.com/bitcoin/raw/block/${hash}`)).json();
    console.log("Block JSON: ", blockJSON);
    const hex = blockJSON.data[hash].raw_block;
    console.log("Block hex: ", hex);

    const numBytes = hex.length / 2;
    this.blockData = hexToUint32Array(hex);

    console.log("Block data size: ", this.blockData.byteLength);
    console.log("Block data: ", new Uint32Array(this.blockData));
    console.log("Block size: ", hex.length, hex.length / 2);

    // We need to ensure that the blockData pads to 512 bits (64 bytes)
    const paddedBlockData = new Uint8Array(Math.ceil(numBytes / 64) * 64);
    paddedBlockData.set(new Uint8Array(this.blockData.buffer), 0);
    this.blockData = paddedBlockData.buffer;

    this.hexBuffer = this.createBuffer(ONE_MB, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.device.queue.writeBuffer(this.hexBuffer, 0, this.blockData);

    console.log("Finished loading block.");
  }

  async run() {
    if (!this.initialized) return console.error("Run called before initialization.");

    const commandEncoder = this.device.createCommandEncoder();

    const numThreads = 1;
    const nonceOffset = 0;
    const workgroup_X = 8;
    const outputBufferBytes = numThreads * 32;

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

    this.device.queue.submit([commandEncoder.finish()]);

    const resultOutputBuffer = this.createOutputBuffer(commandEncoder, ResultBuffer, outputBufferBytes);

    await resultOutputBuffer.mapAsync(GPUMapMode.READ);
    const output = resultOutputBuffer.getMappedRange();

    return new Uint32Array(output);
  }

  initBindGroups() {
    this.r_BindLayout = this.createBindGroupLayout(["read-only-storage"]);
    this.u_s_BindLayout = this.createBindGroupLayout(["uniform", "storage"]);
  }

  initPipelines() {
    this.sha256Pipeline = this.createPipeline(sha256Shader(), [this.u_s_BindLayout, this.r_BindLayout]);
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

function hexToUint32Array(hexStr) {
  const uint32ArrayLength = Math.ceil(hexStr.length / 8);
  const uint32Array = new Uint32Array(uint32ArrayLength);

  for (let i = 0; i < uint32ArrayLength; i++) {
    const start = i * 8;
    const end = start + 8;
    const chunk = hexStr.slice(start, end);
    uint32Array[i] = parseInt(chunk, 16);
  }

  return uint32Array;
}

const workgroupCalc = (dim, size) => Math.min(Math.ceil(dim / size), 256);

// Referenced from https://github.com/MarcoCiaramella/sha256-gpu/blob/main/index.js
const sha256Shader = () => `
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

  const megabyte: u32 = 1048576;
  const num_chunks: u32 = 16384; // 1 megabyte / 512 bits

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

      for (var i = 0u; i < num_chunks; i++){
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
