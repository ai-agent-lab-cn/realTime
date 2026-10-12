export interface AudioSegment {
  id: number
  revision: number
  final: boolean
  time: number
  pcm: Float32Array
}

const RATE = 16000
const FRAME = 320
const PREROLL_FRAMES = 15
const MIN_SPEECH_FRAMES = 13
const PAUSE_FRAMES = 30
const SHORT_SPEECH_PAUSE_FRAMES = 60
const PARTIAL_FRAMES = 75
const MAX_FRAMES = 600
const ENERGY_THRESHOLD = 0.015

export class SpeechSegmenter {
  private pending = new Float32Array()
  private preRoll: Float32Array[] = []
  private active: Float32Array[] = []
  private id = 0
  private revision = 0
  private voiceFrames = 0
  private quietFrames = 0
  private framesSincePartial = 0
  private totalFrames = 0
  private startFrame = 0

  push(samples: Float32Array): AudioSegment[] {
    const joined = new Float32Array(this.pending.length + samples.length)
    joined.set(this.pending)
    joined.set(samples, this.pending.length)
    const events: AudioSegment[] = []
    let offset = 0
    while (offset + FRAME <= joined.length) {
      const frame = joined.slice(offset, offset + FRAME)
      events.push(...this.process(frame))
      offset += FRAME
    }
    this.pending = joined.slice(offset)
    return events
  }

  private process(frame: Float32Array): AudioSegment[] {
    const now = this.totalFrames++
    let power = 0
    for (const sample of frame) power += sample * sample
    const speaking = Math.sqrt(power / FRAME) >= ENERGY_THRESHOLD
    const events: AudioSegment[] = []
    let hardSplit = false
    if (!this.active.length && speaking) {
      this.active = this.preRoll.slice()
      this.startFrame = Math.max(0, now - this.active.length)
      this.revision = 0
      this.voiceFrames = 0
      this.quietFrames = 0
      this.framesSincePartial = 0
    }
    if (this.active.length || speaking) {
      this.active.push(frame)
      if (speaking) {
        this.voiceFrames++
        this.quietFrames = 0
      } else this.quietFrames++
      this.framesSincePartial++
      if (this.active.length >= MAX_FRAMES) {
        if (this.voiceFrames >= MIN_SPEECH_FRAMES) events.push(this.emit(true))
        this.reset()
        this.preRoll = []
        hardSplit = true
      } else if (
        this.quietFrames >=
        (this.voiceFrames < 50
          ? SHORT_SPEECH_PAUSE_FRAMES
          : this.active.length >= 500
            ? 14
            : PAUSE_FRAMES)
      ) {
        if (this.voiceFrames >= MIN_SPEECH_FRAMES) events.push(this.emit(true))
        this.reset()
      } else if (
        this.voiceFrames >= MIN_SPEECH_FRAMES &&
        this.active.length >= PARTIAL_FRAMES &&
        this.framesSincePartial >= PARTIAL_FRAMES
      ) {
        events.push(this.emit(false))
        this.framesSincePartial = 0
      }
    }
    if (!hardSplit) {
      this.preRoll.push(frame)
      if (this.preRoll.length > PREROLL_FRAMES) this.preRoll.shift()
    }
    return events
  }

  private emit(final: boolean): AudioSegment {
    const pcm = new Float32Array(this.active.length * FRAME)
    this.active.forEach((frame, index) => pcm.set(frame, index * FRAME))
    const event = {
      id: this.id,
      revision: ++this.revision,
      final,
      time: (this.startFrame * FRAME) / RATE,
      pcm,
    }
    if (final) this.id++
    return event
  }

  private reset() {
    this.active = []
    this.voiceFrames = 0
    this.quietFrames = 0
    this.framesSincePartial = 0
  }
}
