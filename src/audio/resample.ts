/** Continuous linear resampling, with phase retained between AudioWorklet packets. */
export class StreamingResampler {
  private inputCount = 0
  private nextOutput = 0
  private previous = 0
  private readonly step: number

  constructor(inputRate: number, outputRate = 16000) {
    if (!Number.isFinite(inputRate) || inputRate < outputRate || outputRate <= 0) {
      throw new Error('不支持的麦克风采样率')
    }
    this.step = inputRate / outputRate
  }

  push(input: Float32Array): Float32Array {
    if (!input.length) return new Float32Array()
    const start = this.inputCount
    const end = start + input.length - 1
    const output: number[] = []
    while (this.nextOutput <= end) {
      const left = Math.floor(this.nextOutput)
      const fraction = this.nextOutput - left
      if (fraction > 0 && left === end) break
      const a = left < start ? this.previous : input[left - start]
      const b = fraction ? input[left + 1 - start] : a
      output.push(a + (b - a) * fraction)
      this.nextOutput += this.step
    }
    this.inputCount += input.length
    this.previous = input[input.length - 1]
    return Float32Array.from(output)
  }
}
