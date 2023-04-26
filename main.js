class Miner {
  constructor() {
    this.initialized = false;
    this.device = null;
  }

  async initialize() {
    if (this.initialized) return console.error("Model already initialized");
    if (!navigator.gpu) throw new Error("WebGPU is not supported");

    const adapter = await navigator.gpu.requestAdapter();
    this.device = await adapter.requestDevice();

    const foo = await this.loadModel(this.folder);

    this.initialized = true;
  }

  async loadBlock(block) {
    if (this.initialized) {
      console.error("Miner already loaded");
      return;
    }

    // Example loading a buffer.
    // console.log("Loading token embeddings...");
    // const embeddingWeights = await loadBinaryFile("models/" + folder + "/transformer.wte.weight_gpt.bin");
    // const embeddingWeightsBuffer = createBuffer(this.device, this.bufferSizeCalc(vocab_size, n_embd), GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    // this.device.queue.writeBuffer(embeddingWeightsBuffer, 0, embeddingWeights);

    console.log("Finished loading miner.");
    return null;
  }

  async run(block) {
    const commandEncoder = this.device.createCommandEncoder();

    // const matmulUniformBuffer = createBuffer(this.device, 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // const matmulResultBuffer = createBuffer(this.device, this.bufferSizeCalc(rows, cols), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    // const matMulBindGroup = createBindGroup(this.device, this.u_s_BindLayout, [matmulUniformBuffer, matmulResultBuffer]);
    // this.device.queue.writeBuffer(matmulUniformBuffer, 0, new Uint32Array([rows, cols, shared]));

    // const passEncoder = commandEncoder.beginComputePass();
    // passEncoder.setPipeline(this.matmulPipeline);
    // passEncoder.setBindGroup(0, matMulBindGroup);
    // passEncoder.setBindGroup(1, createBindGroup(this.device, this.r_r_BindLayout, [Abuffer, Bbuffer]));
    // passEncoder.dispatchWorkgroups(workgroupCalc(rows, workgroup_Y), workgroupCalc(cols, workgroup_X));
    // passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);

    await deEmbedOutputBuffer.mapAsync(GPUMapMode.READ);
    const output = deEmbedOutputBuffer.getMappedRange();

    return new Float32Array(output);
  }

  bufferSizeCalc(dimA, dimB = 1) {
    return alignedSize(dimA * dimB * Float32Array.BYTES_PER_ELEMENT, 1);
  }

  initBindGroups() {
    this.r_BindLayout = createBindGroupLayout(this.device, ["read-only-storage"]);
    this.u_s_BindLayout = createBindGroupLayout(this.device, ["uniform", "storage"]);
  }

  initPipelines() {
    this.sha256Pipeline = createPipeline(this.device, matMulShader, [this.u_s_BindLayout, this.r_BindLayout]);
  }
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
