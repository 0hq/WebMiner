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

    this.initialized = true;
  }

  async loadBlock(hash) {
    if (this.initialized) {
      console.error("Miner already loaded");
      return;
    }

    // Pull from https://api.blockchair.com/bitcoin/raw/block/
    const blockJSON = await (await fetch(`https://api.blockchair.com/bitcoin/raw/block/${hash}`)).json();
    const hex = blockJSON.data[hash].raw_block;

    // Example loading a buffer.
    const exampleValue = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const exampleBuffer = this.createBuffer(this.device, this.bufferSize(exampleValue.length), GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.device.queue.writeBuffer(exampleBuffer, 0, exampleValue);

    console.log("Finished loading miner.");
    return null;
  }

  async run() {
    const commandEncoder = this.device.createCommandEncoder();

    const rows = 16;
    const cols = 16;

    const exampleUniformBuffer = this.createBuffer(this.device, 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const exampleResultBuffer = this.createBuffer(this.device, this.bufferSize(rows, cols), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const exampleBindGroup = this.createBindGroup(this.device, this.u_s_BindLayout, [exampleUniformBuffer, exampleResultBuffer]);
    this.device.queue.writeBuffer(exampleUniformBuffer, 0, new Uint32Array([rows, cols]));

    const examplePassEncoder = commandEncoder.beginComputePass();
    examplePassEncoder.setPipeline(this.examplePipeline);
    examplePassEncoder.setBindGroup(0, exampleBindGroup);
    examplePassEncoder.setBindGroup(1, this.createBindGroup(this.device, this.r_r_BindLayout, [Abuffer, Bbuffer]));
    examplePassEncoder.dispatchWorkgroups(workgroupCalc(rows, workgroup_Y), workgroupCalc(cols, workgroup_X));
    examplePassEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);

    await exampleBuffer.mapAsync(GPUMapMode.READ);
    const output = exampleBuffer.getMappedRange();

    return new Float32Array(output);
  }

  initBindGroups() {
    this.r_BindLayout = this.createBindGroupLayout(["read-only-storage"]);
    this.u_s_BindLayout = this.createBindGroupLayout(["uniform", "storage"]);
  }

  initPipelines() {
    this.sha256Pipeline = this.createPipeline(matMulShader, [this.u_s_BindLayout, this.r_BindLayout]);
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

  createOutputBuffer(commandEncoder, buffer, rows, cols) {
    const outputBufferSize = bufferSize(rows, cols);
    const outputBuffer = this.createBuffer(outputBufferSize, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    commandEncoder.copyBufferToBuffer(buffer, 0, outputBuffer, 0, outputBufferSize);
    return outputBuffer;
  }
}

function bufferSize(dimA, dimB = 1) {
  return dimA * dimB * Float32Array.BYTES_PER_ELEMENT;
}

// Multiplies two matrices.
// Example shader.
const matMulShader = `
    struct Matrix {
        data: array<f32>,
    }

    struct Uniforms {
      dimY: u32, // row dimension of A and row dimension of C
      dimX: u32, // col dimension of B and col dimension of C
      dimS: u32, // shared dimension of A and B
    };

    @group(1) @binding(0) var<storage, read> A: Matrix;
    @group(1) @binding(1) var<storage, read> B: Matrix;

    @group(0) @binding(1) var<storage, read_write> C: Matrix;
    @group(0) @binding(0) var<uniform> dimBuffer: Uniforms;

    @compute @workgroup_size(16, 16)
    fn main (@builtin(global_invocation_id) global_id: vec3<u32>) {
        let row: u32 = global_id.x;
        let col: u32 = global_id.y;
        let dimX: u32 = dimBuffer.dimX;
        let dimY: u32 = dimBuffer.dimY;
        let dimS: u32 = dimBuffer.dimS;

        if (row >= dimY || col >= dimX) {
          return;
        }

        var sum: f32 = 0.0;
        for (var i: u32 = 0; i < dimS; i = i + 1) {
            sum = sum + A.data[row * dimS + i] * B.data[i * dimX + col];
        }

        C.data[row * dimX + col] = sum;
      }
  `;
