class CPUMiner {
  constructor(block) {
    const prevBlockHash = this.hexToUint8Array(block.previousblockhash);
    const mrklRoot = this.hexToUint8Array(block.merkleroot);
    const { time, version } = block;

    const bits = parseInt("0x" + block.bits, 16);
    const exponent = bits >> 24;
    const mantissa = bits & 0xffffff;
    const target = (mantissa * 2 ** (8 * (exponent - 3))).toString(16);

    this.targetBuffer = this.hexToUint8Array("0".repeat(64 - target.length) + target);

    this.versionBuffer = new Uint8Array(4);
    this.writeUInt32LE(this.versionBuffer, version, 0);

    this.reversedPrevBlockHash = this.reverseBuffer(prevBlockHash);
    this.reversedMrklRoot = this.reverseBuffer(mrklRoot);

    this.timeBitsNonceBuffer = new Uint8Array(12);
    this.writeUInt32LE(this.timeBitsNonceBuffer, time, 0);
    this.writeUInt32LE(this.timeBitsNonceBuffer, bits, 4);
  }

  reverseBuffer(src) {
    const buffer = new Uint8Array(src.length);
    for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
      buffer[i] = src[j];
      buffer[j] = src[i];
    }
    return buffer;
  }

  hexToUint8Array(hex) {
    console.log("hex", hex, typeof hex);
    const length = hex.length / 2;
    const buffer = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      buffer[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return buffer;
  }

  async sha256(buf) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return new Uint8Array(digest);
  }

  async sha256sha256(buf) {
    const first = await this.sha256(buf);
    console.log("First SHA:", this.toHexString(this.reverseBuffer(first)));
    return this.sha256(first);
  }

  async getHash(nonce) {
    this.writeUInt32LE(this.timeBitsNonceBuffer, nonce, 8);
    console.log(
      "timeBitsNonceBuffer",
      this.toHexString(new Uint8Array([...this.versionBuffer, ...this.reversedPrevBlockHash, ...this.reversedMrklRoot, ...this.timeBitsNonceBuffer]))
    );
    return this.reverseBuffer(
      await this.sha256sha256(new Uint8Array([...this.versionBuffer, ...this.reversedPrevBlockHash, ...this.reversedMrklRoot, ...this.timeBitsNonceBuffer]))
    );
  }

  getTarget() {
    return this.targetBuffer;
  }

  checkHash(hash) {
    const target = this.getTarget().reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
    const hashHex = hash.reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
    return target > hashHex;
  }

  toHexString(buffer) {
    return Array.from(buffer)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  writeUInt32LE(buffer, value, offset) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
    buffer[offset + 2] = (value >> 16) & 0xff;
    buffer[offset + 3] = (value >> 24) & 0xff;
  }
}

(async () => {
  const block = {
    version: 1,
    previousblockhash: "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
    merkleroot: "9b0fc92260312ce44e74ef369f5c66bbb85848f2eddd5a7a1cde251e54ccfdd5",
    time: 1231469744,
    bits: "1d00ffff",
  };
  const nonce = 1639830024;
  const miner = new CPUMiner(block);
  console.log("Mining...");
  console.log("OUPTUT Block hash:", miner.toHexString(await miner.getHash(nonce)));
})();

// 695b16a34003e15ac809f985ad5177f76571f65a328df0c27b34f75018a9bb9c
