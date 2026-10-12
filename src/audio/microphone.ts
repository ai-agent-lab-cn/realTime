export function workletUrl(pageUrl: string): string {
  return new URL('audio-capture-worklet.js', pageUrl).href
}

export class MicrophoneCapture {
  private stopped = false

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly worklet: AudioWorkletNode,
    private readonly mutedOutput: GainNode,
  ) {}

  static async start(
    onSamples: (samples: Float32Array, sampleRate: number) => void,
    onEnded: () => void,
  ): Promise<MicrophoneCapture> {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error('当前环境不支持麦克风采集')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    let context: AudioContext | undefined
    try {
      context = new AudioContext()
      await context.audioWorklet.addModule(workletUrl(document.baseURI))
      const source = context.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(context, 'shiyi-capture')
      const mutedOutput = context.createGain()
      mutedOutput.gain.value = 0
      source.connect(worklet)
      worklet.connect(mutedOutput)
      mutedOutput.connect(context.destination)
      const capture = new MicrophoneCapture(stream, context, source, worklet, mutedOutput)
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!capture.stopped) onSamples(event.data, context!.sampleRate)
      }
      for (const track of stream.getTracks())
        track.addEventListener('ended', () => {
          if (!capture.stopped) onEnded()
        })
      context.addEventListener('statechange', () => {
        if (!capture.stopped && context?.state === 'closed') onEnded()
      })
      await context.resume()
      return capture
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      if (context && context.state !== 'closed') await context.close()
      throw error
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.worklet.port.onmessage = null
    this.source.disconnect()
    this.worklet.disconnect()
    this.mutedOutput.disconnect()
    this.stream.getTracks().forEach((track) => track.stop())
    if (this.context.state !== 'closed') void this.context.close()
  }
}
