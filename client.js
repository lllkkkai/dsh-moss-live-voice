/**
 * Browser half of the MOSS-Live voice bundle: same-origin carrier WebSocket, 16 kHz microphone uplink,
 * 48 kHz playback with playback receipts, captions and barge-in. Every side effect (socket, audio
 * contexts, worklet blob URL, media stream, timers) is released when the component unmounts.
 */

window.__ModuleLoader__.load({
  id: 'dsh-moss-live-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Uplink format: 20 ms of 16 kHz mono PCM16, one frame per 320 samples / 640 bytes. */
    const MIC_RATE = 16000
    const MIC_FRAME_MS = 20
    const MIC_FRAME_SAMPLES = (MIC_RATE * MIC_FRAME_MS) / 1000
    /** Downlink format: 48 kHz mono PCM16, already chunked by response.audio.context. */
    const SPEAKER_RATE = 48000
    /** Scheduling lead so the playback clock never underruns a chunk boundary. */
    const LEAD_SECONDS = 0.08
    /** Bound on unmatched audio contexts before playback is treated as broken. */
    const MAX_CONTEXTS = 256
    /** Carrier path served by the host plugin on the same origin. */
    const CARRIER_PATH = '/moss-live/v1'

    // ---------------------------------------------------------------------------------------------
    // PCM helpers, ported from examples/browser-demo/web/js/pcm.js of the unpacked MOSS package.
    // ---------------------------------------------------------------------------------------------

    /** Windowed-sinc low-pass used as the anti-alias filter before decimation. */
    class LowPassFIR {
      constructor(cutoff, taps = 48) {
        this.taps = taps
        this.h = new Float32Array(taps)
        const center = (taps - 1) / 2
        let sum = 0
        for (let n = 0; n < taps; n += 1) {
          const x = n - center
          const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
          const angle = (2 * Math.PI * n) / (taps - 1)
          const window = 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle)
          this.h[n] = sinc * window
          sum += this.h[n]
        }
        for (let n = 0; n < taps; n += 1) this.h[n] /= sum // unity gain at DC
        this.history = new Float32Array(taps - 1)
      }

      /** Convolve one block and keep the filter tail for the next block. */
      process(x) {
        const length = x.length
        if (length === 0) return new Float32Array(0)
        const taps = this.taps
        const extended = new Float32Array(taps - 1 + length)
        extended.set(this.history, 0)
        extended.set(x, taps - 1)
        const out = new Float32Array(length)
        for (let i = 0; i < length; i += 1) {
          let acc = 0
          for (let k = 0; k < taps; k += 1) acc += this.h[k] * extended[i + taps - 1 - k]
          out[i] = acc
        }
        this.history = extended.slice(extended.length - (taps - 1))
        return out
      }
    }

    /** Streaming linear interpolation resampler with cross-block continuity. */
    class LinearResampler {
      constructor(inputRate, outputRate) {
        this.step = inputRate / outputRate
        this.pos = 0
        this.prev = 0
      }

      process(x) {
        if (x.length === 0) return new Float32Array(0)
        const out = []
        let pos = this.pos
        const last = x.length - 1
        while (pos < last) {
          const index = Math.floor(pos)
          const frac = pos - index
          const a = index < 0 ? this.prev : x[index]
          const b = x[index + 1]
          out.push(a + (b - a) * frac)
          pos += this.step
        }
        this.pos = pos - x.length
        this.prev = x[last]
        return Float32Array.from(out)
      }
    }

    /** Clip floats to [-1, 1] and convert to little-endian PCM16. */
    function floatToPCM16(x) {
      const out = new Int16Array(x.length)
      for (let i = 0; i < x.length; i += 1) {
        const v = Math.max(-1, Math.min(1, x[i]))
        out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff)
      }
      return out
    }

    /** Convert little-endian PCM16 bytes to floats without copying the source buffer. */
    function pcm16ToFloat(bytes) {
      const isBuffer = bytes instanceof ArrayBuffer
      const buffer = isBuffer ? bytes : bytes.buffer
      const offset = isBuffer ? 0 : (bytes.byteOffset ?? 0)
      const length = isBuffer ? bytes.byteLength : (bytes.byteLength ?? buffer.byteLength)
      const view = new DataView(buffer, offset, length)
      const count = Math.floor(view.byteLength / 2)
      const out = new Float32Array(count)
      for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000
      return out
    }

    /** Duration of one PCM16 chunk at the playback rate. */
    function chunkDurationMS(byteLength, rate = SPEAKER_RATE) {
      return ((byteLength / 2) / rate) * 1000
    }

    /** Turns capture-rate blocks into whole 16 kHz / 20 ms PCM16 frames. */
    class MicFramer {
      constructor({ inputRate, outputRate = MIC_RATE, frameMs = MIC_FRAME_MS } = {}) {
        if (!inputRate) throw new Error('MicFramer needs the capture rate')
        this.outputRate = outputRate
        this.frameSamples = Math.round((outputRate * frameMs) / 1000)
        this.fir = inputRate > outputRate ? new LowPassFIR((0.45 * outputRate) / inputRate) : null
        this.resampler = inputRate === outputRate ? null : new LinearResampler(inputRate, outputRate)
        this.tail = new Float32Array(0)
      }

      /** Filter, resample and slice one capture block into complete 20 ms frames. */
      push(block) {
        let x = block
        if (this.fir !== null) x = this.fir.process(x)
        if (this.resampler !== null) x = this.resampler.process(x)
        if (x.length === 0 && this.tail.length < this.frameSamples) return []
        const merged = new Float32Array(this.tail.length + x.length)
        merged.set(this.tail, 0)
        merged.set(x, this.tail.length)
        const frames = []
        let offset = 0
        while (merged.length - offset >= this.frameSamples) {
          frames.push(floatToPCM16(merged.subarray(offset, offset + this.frameSamples)).buffer)
          offset += this.frameSamples
        }
        this.tail = merged.slice(offset)
        return frames
      }
    }

    // ---------------------------------------------------------------------------------------------
    // AudioWorklet capture thread, inlined so the plugin stays a single self-contained file.
    // Adapted from examples/browser-demo/web/js/capture-worklet.js.
    // ---------------------------------------------------------------------------------------------

    const CAPTURE_WORKLET = [
      'class MossCaptureProcessor extends AudioWorkletProcessor {',
      '  constructor(options) {',
      '    super()',
      '    this.blockSamples = (options && options.processorOptions && options.processorOptions.blockSamples) || 512',
      '    this.buffer = new Float32Array(this.blockSamples)',
      '    this.filled = 0',
      '  }',
      '  process(inputs) {',
      '    const channel = inputs[0] && inputs[0][0]',
      '    if (!channel) { this.filled = 0; return true }',
      '    for (let i = 0; i < channel.length; i += 1) {',
      '      if (this.filled === 0) this.startFrame = currentFrame + i',
      '      this.buffer[this.filled] = channel[i]',
      '      this.filled += 1',
      '      if (this.filled === this.blockSamples) {',
      '        const samples = this.buffer.slice()',
      '        this.port.postMessage({ samples, startFrame: this.startFrame }, [samples.buffer])',
      '        this.filled = 0',
      '      }',
      '    }',
      '    return true',
      '  }',
      '}',
      'registerProcessor(\'moss-capture\', MossCaptureProcessor)',
    ].join('\n')

    /** One microphone stream: getUserMedia, worklet capture and the 16 kHz framer. */
    class Microphone {
      static async open({ ctx, onFrame }) {
        const devices = navigator.mediaDevices
        if (devices === undefined || typeof devices.getUserMedia !== 'function') {
          throw new Error('浏览器不支持麦克风采集')
        }
        const stream = await devices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        return new Microphone(stream, { ctx, onFrame })
      }

      constructor(stream, { ctx, onFrame }) {
        this.stream = stream
        this.ctx = ctx
        this.onFrame = onFrame
        this.framer = new MicFramer({ inputRate: ctx.sampleRate })
        this.nextInputFrame = null
        this.source = null
        this.node = null
        this.sink = null
        this.closed = false
      }

      /** Load the worklet from a blob URL and wire the capture graph into a silent sink. */
      async start() {
        if (this.ctx.audioWorklet === undefined) throw new Error('AudioWorklet 不可用')
        const blob = new Blob([CAPTURE_WORKLET], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        try {
          await this.ctx.audioWorklet.addModule(url)
        } finally {
          URL.revokeObjectURL(url)
        }
        if (this.closed) return
        this.source = this.ctx.createMediaStreamSource(this.stream)
        this.node = new AudioWorkletNode(this.ctx, 'moss-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: { blockSamples: Math.round((this.ctx.sampleRate * MIC_FRAME_MS) / 1000) },
        })
        this.node.port.onmessage = (event) => this.onBlock(event.data)
        this.sink = this.ctx.createGain()
        this.sink.gain.value = 0
        this.source.connect(this.node)
        this.node.connect(this.sink)
        this.sink.connect(this.ctx.destination)
      }

      /** Handle one capture block; a frame-number gap means the worklet restarted. */
      onBlock(block) {
        if (this.closed || block === null || typeof block !== 'object') return
        const samples = block.samples
        if (!(samples instanceof Float32Array)) return
        if (Number.isSafeInteger(block.startFrame)) {
          if (this.nextInputFrame !== null && block.startFrame !== this.nextInputFrame) {
            this.framer = new MicFramer({ inputRate: this.ctx.sampleRate })
          }
          this.nextInputFrame = block.startFrame + samples.length
        }
        for (const frame of this.framer.push(samples)) this.onFrame(frame)
      }

      close() {
        this.closed = true
        if (this.node !== null) this.node.port.onmessage = null
        for (const node of [this.source, this.node, this.sink]) {
          if (node === null) continue
          try {
            node.disconnect()
          } catch {
            /* node already detached */
          }
        }
        for (const track of this.stream.getTracks()) {
          try {
            track.stop()
          } catch {
            /* track already stopped */
          }
        }
      }
    }

    // ---------------------------------------------------------------------------------------------
    // Playback ledger, ported from examples/browser-demo/web/js/playback.js.
    // Tracks queued / played PCM chunks using the public playback receipts.
    // ---------------------------------------------------------------------------------------------

    class Scope {
      constructor() {
        this.turnId = ''
        this.finished = false
        this.drained = false
        this.stopped = false
        this.outstanding = 0
        this.playedMS = 0
      }
    }

    /** State machine that decides when a chunk or a whole run has really played. */
    class PlaybackLedger {
      constructor() {
        /** Contexts announced but not yet matched by an audio frame. */
        this.pending = []
        /** Chunks waiting for the speaker. */
        this.queue = []
        /** Chunks handed to the speaker but not finished yet. */
        this.inFlight = new Map()
        this.scopes = new Map()
        this.seq = 0
      }

      scopeFor(runId, turnId) {
        let scope = this.scopes.get(runId)
        if (scope === undefined) {
          scope = new Scope()
          this.scopes.set(runId, scope)
        }
        if (turnId) scope.turnId = turnId
        return scope
      }

      onStart(runId, turnId) {
        const scope = this.scopeFor(runId, turnId)
        scope.finished = false
        scope.drained = false
        scope.stopped = false
        scope.playedMS = 0
      }

      onContext(ref) {
        if (!ref.chunkId || !ref.runId || !ref.turnId) throw new Error('audio context needs ids')
        this.pending.push({ chunkId: ref.chunkId, runId: ref.runId, turnId: ref.turnId })
      }

      onAudio(byteLength, payload) {
        if (this.pending.length === 0) throw new Error('audio without context')
        const ref = this.pending.shift()
        if (ref.runId) this.scopeFor(ref.runId, ref.turnId).outstanding += 1
        const chunk = {
          seq: (this.seq += 1),
          ref,
          bytes: byteLength,
          durationMS: chunkDurationMS(byteLength),
          payload,
        }
        this.queue.push(chunk)
        return chunk
      }

      takeNext() {
        const chunk = this.queue.shift()
        if (chunk === undefined) return null
        this.inFlight.set(chunk.seq, chunk)
        return chunk
      }

      played(chunk) {
        this.inFlight.delete(chunk.seq)
        const messages = [this.ackChunk(chunk.ref)]
        if (!chunk.ref.runId) return messages
        const scope = this.scopeFor(chunk.ref.runId, chunk.ref.turnId)
        if (scope.outstanding > 0) scope.outstanding -= 1
        // played_audio_ms must cover finished chunks plus the partial chunk of a barge-in.
        scope.playedMS += chunk.durationMS
        return messages.concat(this.maybeDrain(chunk.ref.runId, scope))
      }

      onFinished(runId, turnId) {
        const scope = this.scopeFor(runId, turnId)
        scope.finished = true
        return this.maybeDrain(runId, scope)
      }

      cancelInFlight(runId, partialMS = 0) {
        const dropped = []
        for (const [seq, chunk] of this.inFlight) {
          if (chunk.ref.runId !== runId) continue
          this.inFlight.delete(seq)
          dropped.push(chunk)
        }
        if (partialMS > 0) this.scopeFor(runId, '').playedMS += partialMS
        return dropped
      }

      /** Barge-in: drop the queued chunks and answer with one playback.stopped receipt. */
      onStop(runId, turnId, reason) {
        const dropped = []
        this.queue = this.queue.filter((chunk) => {
          if (chunk.ref.runId !== runId) return true
          dropped.push(chunk)
          return false
        })
        const scope = this.scopeFor(runId, turnId)
        scope.outstanding = 0
        scope.finished = true
        scope.stopped = true
        scope.drained = true
        const played = scope.playedMS
        scope.playedMS = 0
        return {
          messages: [{
            action: 'playback.stopped',
            reason,
            run_id: runId,
            turn_id: scope.turnId,
            played_audio_ms: played,
          }],
          dropped,
        }
      }

      /** Terminal run without receipts: the server already interrupted it. */
      onInterrupted(runId, turnId) {
        this.queue = this.queue.filter((chunk) => chunk.ref.runId !== runId)
        const scope = this.scopeFor(runId, turnId)
        scope.outstanding = 0
        scope.finished = true
        scope.stopped = true
        scope.drained = true
        scope.playedMS = 0
      }

      maybeDrain(runId, scope) {
        if (!scope.finished || scope.drained || scope.stopped || scope.outstanding > 0) return []
        scope.drained = true
        return [this.ackDrained(runId, scope.turnId)]
      }

      ackChunk(ref) {
        return {
          action: 'playback.chunk.completed',
          chunk_id: ref.chunkId,
          run_id: ref.runId,
          turn_id: ref.turnId,
        }
      }

      ackDrained(runId, turnId) {
        return { action: 'playback.completed', run_id: runId, turn_id: turnId }
      }
    }

    // ---------------------------------------------------------------------------------------------
    // 48 kHz playback scheduler, ported from examples/browser-demo/web/js/speaker.js.
    // ---------------------------------------------------------------------------------------------

    /** Schedules PCM chunks on the audio clock and acknowledges what actually played. */
    class Speaker {
      constructor({ ctx, ledger, onMessages }) {
        this.ctx = ctx
        this.ledger = ledger
        this.onMessages = onMessages
        this.gainNode = ctx.createGain()
        this.gainNode.connect(ctx.destination)
        this.live = []
        this.nextStart = 0
      }

      /** Pull every queued chunk into a gapless chain on the playback clock. */
      schedule() {
        const now = this.ctx.currentTime
        if (this.nextStart < now + LEAD_SECONDS) this.nextStart = now + LEAD_SECONDS
        for (;;) {
          const chunk = this.ledger.takeNext()
          if (chunk === null) break
          const samples = chunk.payload instanceof Float32Array ? chunk.payload : pcm16ToFloat(chunk.payload)
          const buffer = this.ctx.createBuffer(1, Math.max(1, samples.length), SPEAKER_RATE)
          buffer.getChannelData(0).set(samples)
          const source = this.ctx.createBufferSource()
          source.buffer = buffer
          source.connect(this.gainNode)
          const start = this.nextStart
          const end = start + chunk.durationMS / 1000
          source.start(start)
          source.onended = () => this.tick()
          this.live.push({ chunk, source, start, end })
          this.nextStart = end
        }
      }

      /** Emit receipts for chunks whose audio clock window has elapsed. */
      tick(now = this.ctx.currentTime) {
        const messages = []
        while (this.live.length > 0 && this.live[0].end <= now) {
          const record = this.live.shift()
          messages.push(...this.ledger.played(record.chunk))
        }
        if (messages.length > 0) this.onMessages(messages)
        return messages
      }

      /** Stop one run immediately and report how much of it the user really heard. */
      stopScope(runId) {
        const now = this.ctx.currentTime
        this.tick(now)
        let partialMS = 0
        const keep = []
        for (const record of this.live) {
          if (record.chunk.ref.runId !== runId) {
            keep.push(record)
            continue
          }
          if (record.start <= now && now < record.end) partialMS += (now - record.start) * 1000
          record.source.onended = null
          try {
            record.source.stop()
          } catch {
            /* source already stopped */
          }
        }
        this.live = keep
        this.nextStart = keep.length > 0 ? Math.max(now, keep[keep.length - 1].end) : now
        this.ledger.cancelInFlight(runId, partialMS)
        return partialMS
      }

      reset() {
        for (const record of this.live) {
          record.source.onended = null
          try {
            record.source.stop()
          } catch {
            /* source already stopped */
          }
        }
        this.live = []
        this.nextStart = 0
      }
    }

    // ---------------------------------------------------------------------------------------------
    // Small helpers.
    // ---------------------------------------------------------------------------------------------

    /** Monotonic-ish clock used for uplink frame pacing. */
    function nowMS() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
    }

    /** Same-origin carrier endpoint. */
    function carrierUrl() {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      return scheme + '://' + location.host + CARRIER_PATH
    }

    /** Short human readable description of an unknown thrown value. */
    function describeError(error) {
      const message = error === null || error === undefined
        ? '未知错误'
        : (typeof error.message === 'string' ? error.message : String(error))
      const chars = Array.from(message)
      return chars.length > 120 ? chars.slice(0, 119).join('') + '…' : message
    }

    /** Microphone failures get actionable Chinese copy instead of a raw DOMException name. */
    function describeMicFailure(error) {
      const name = error === null || error === undefined ? '' : error.name
      if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，请在地址栏允许后重试'
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有检测到麦克风设备'
      if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风被其他程序占用'
      if (name === 'NotSupportedError') return '浏览器不支持所需的音频能力'
      return describeError(error)
    }

    /** Trim a string to a code-point budget for compact rows. */
    function clip(text, maxChars) {
      const chars = Array.from(text)
      return chars.length > maxChars ? chars.slice(0, maxChars - 1).join('') + '…' : text
    }

    /** Uplink frames are tagged-v1: one zero byte in front of the 640-byte PCM payload. */
    function tagFrame(pcm) {
      const bytes = pcm instanceof ArrayBuffer ? new Uint8Array(pcm) : new Uint8Array(pcm.buffer)
      const tagged = new Uint8Array(bytes.length + 1)
      tagged.set(bytes, 1)
      return tagged.buffer
    }

    const PHASE_LABELS = { idle: '未连接', connecting: '连接中', live: '会话中', error: '出错' }
    const TASK_LABELS = {
      queued: '排队中',
      running: '执行中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '连接断开',
    }
    const RESPONSE_LABELS = {
      completed: '回答结束',
      interrupted: '被打断',
      failed: '回答失败',
      cancelled: '已取消',
    }

    /** Initial React view model; the engine owns every field after mount. */
    const INITIAL_VIEW = {
      phase: 'idle',
      socketState: 'closed',
      statusText: '',
      notice: '',
      muted: false,
      micOpen: false,
      inputText: '',
      outputText: '',
      task: null,
      reply: '',
      keyState: null,
      history: [],
      typing: false,
      level: 0,
      aiSpeaking: false,
    }

    // ---------------------------------------------------------------------------------------------
    // Voice engine: owns the socket, capture chain, playback chain and all timers.
    // ---------------------------------------------------------------------------------------------

    class VoiceEngine {
      constructor(onUpdate) {
        this.onUpdate = onUpdate
        this.disposed = false
        this.generation = 0
        this.socket = null
        this.socketState = 'closed'
        this.phase = 'idle'
        this.statusText = ''
        this.notice = ''
        this.muted = false
        this.micOpen = false
        this.micOpening = false
        this.inputText = ''
        this.outputText = ''
        this.task = null
        this.reply = ''
        this.keyState = null
        this.history = []
        this.typing = false
        this.level = 0
        this.levelAt = 0
        this.aiSpeaking = false
        this.lastUserTurn = ''
        this.lastReplyRun = ''
        this.sessionId = ''
        this.ledger = null
        this.speaker = null
        this.playbackCtx = null
        this.playbackTimer = null
        this.contexts = []
        this.stoppedRunIds = new Set()
        this.activeRunId = ''
        this.mic = null
        this.micCtx = null
        this.micTimer = null
        this.micSending = false
        this.lastFrameAt = 0
      }

      /** Publish the current view model; identical notices are collapsed to avoid render loops. */
      emit() {
        if (this.disposed) return
        this.onUpdate({
          phase: this.phase,
          socketState: this.socketState,
          statusText: this.statusText,
          notice: this.notice,
          muted: this.muted,
          micOpen: this.micOpen,
          inputText: this.inputText,
          outputText: this.outputText,
          task: this.task,
          reply: this.reply,
          keyState: this.keyState,
          history: this.history.slice(-40),
          typing: this.typing,
          level: this.level,
          aiSpeaking: this.aiSpeaking,
        })
      }

      setNotice(text) {
        if (this.notice === text) return
        this.notice = text
        this.emit()
      }

      fail(text) {
        this.phase = 'error'
        this.statusText = text
        this.notice = text
        this.socketState = 'closed'
        this.emit()
      }

      connect() {
        if (this.disposed || this.socket !== null) return
        this.generation += 1
        const generation = this.generation
        this.phase = 'connecting'
        this.statusText = '正在连接语音通道…'
        this.notice = ''
        this.inputText = ''
        this.outputText = ''
        this.task = null
        this.reply = ''
        this.history = []
        this.typing = false
        this.level = 0
        this.levelAt = 0
        this.aiSpeaking = false
        this.lastUserTurn = ''
        this.lastReplyRun = ''
        this.socketState = 'connecting'
        this.openPlayback()
        this.emit()
        let socket
        try {
          socket = new WebSocket(carrierUrl())
        } catch (error) {
          this.fail('无法建立语音通道：' + describeError(error))
          return
        }
        socket.binaryType = 'arraybuffer'
        this.socket = socket
        socket.onopen = () => {
          if (this.generation !== generation) return
          this.socketState = 'open'
          this.statusText = '通道已连接，等待上游会话'
          this.send({ action: 'start' })
          void this.requestKeyStatus()
          this.emit()
        }
        socket.onmessage = (event) => {
          if (this.generation !== generation) return
          try {
            this.onCarrierMessage(event)
          } catch (error) {
            this.setNotice('处理语音消息失败：' + describeError(error))
          }
        }
        socket.onerror = () => {
          if (this.generation !== generation) return
          this.setNotice('语音通道出错，请确认 host 插件已启用且已登录')
        }
        socket.onclose = () => {
          if (this.generation !== generation) return
          const failed = this.phase === 'error'
          this.socket = null
          this.socketState = 'closed'
          this.teardownAudio()
          this.phase = failed ? 'error' : 'idle'
          this.statusText = failed ? this.statusText : '通道已断开'
          this.emit()
        }
      }

      disconnect() {
        this.generation += 1
        const socket = this.socket
        this.socket = null
        if (socket !== null) {
          try {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: 'stop' }))
          } catch {
            /* socket already closing */
          }
          try {
            socket.close()
          } catch {
            /* socket already closed */
          }
        }
        this.socketState = 'closed'
        this.teardownAudio()
        this.phase = 'idle'
        this.statusText = '已断开'
        this.notice = ''
        this.emit()
      }

      dispose() {
        this.disposed = true
        this.onUpdate = () => {}
        this.disconnect()
      }

      /** Mute only pauses uplink frames; the capture stream stays open for a quick resume. */
      toggleMute() {
        if (this.mic === null) return
        this.muted = !this.muted
        this.micSending = !this.muted
        this.lastFrameAt = nowMS()
        if (this.muted) this.level = 0
        this.sendMoss({ action: 'mic_state', enabled: !this.muted })
        this.emit()
      }

      /** Open the 48 kHz output context once per connection. */
      openPlayback() {
        if (this.playbackCtx !== null) return
        if (typeof AudioContext !== 'function') {
          this.setNotice('当前浏览器不支持 WebAudio，语音无法播放')
          return
        }
        let ctx
        try {
          ctx = new AudioContext({ sampleRate: SPEAKER_RATE })
        } catch {
          try {
            ctx = new AudioContext()
          } catch (error) {
            this.setNotice('音频播放不可用：' + describeError(error))
            return
          }
        }
        try {
          this.playbackCtx = ctx
          this.ledger = new PlaybackLedger()
          this.speaker = new Speaker({
            ctx,
            ledger: this.ledger,
            onMessages: (messages) => this.sendMossAll(messages),
          })
          void ctx.resume().catch(() => {})
          this.playbackTimer = setInterval(() => this.tickPlayback(), 20)
        } catch (error) {
          this.playbackCtx = null
          this.ledger = null
          this.speaker = null
          this.setNotice('音频播放不可用：' + describeError(error))
        }
      }

      tickPlayback() {
        const speaker = this.speaker
        const playbackCtx = this.playbackCtx
        if (speaker === null || playbackCtx === null) return
        try {
          speaker.tick(playbackCtx.currentTime)
        } catch (error) {
          this.setNotice('播放回执失败：' + describeError(error))
        }
      }

      /** Release playback, capture and timers; safe to call repeatedly. */
      teardownAudio() {
        if (this.playbackTimer !== null) {
          clearInterval(this.playbackTimer)
          this.playbackTimer = null
        }
        this.closeMicrophone()
        const speaker = this.speaker
        this.speaker = null
        if (speaker !== null) {
          try {
            speaker.reset()
          } catch {
            /* sources already gone */
          }
          try {
            speaker.gainNode.disconnect()
          } catch {
            /* gain node already detached */
          }
        }
        this.ledger = null
        this.contexts = []
        this.stoppedRunIds.clear()
        this.activeRunId = ''
        this.reply = ''
        this.muted = false
        const playbackCtx = this.playbackCtx
        this.playbackCtx = null
        if (playbackCtx !== null && playbackCtx.state !== 'closed') {
          void playbackCtx.close().catch(() => {})
        }
      }

      // ---- carrier transport -------------------------------------------------------------------

      send(message) {
        const socket = this.socket
        if (socket === null || socket.readyState !== WebSocket.OPEN) return false
        try {
          socket.send(JSON.stringify(message))
          return true
        } catch {
          return false
        }
      }

      /** Load the durable transcript so a refresh does not lose the conversation. */
      async loadHistory() {
        try {
          const response = await fetch('/moss-live/history?limit=60', { credentials: 'same-origin' })
          const data = await response.json()
          const entries = Array.isArray(data?.entries) ? data.entries : []
          if (entries.length === 0 || this.history.length > 0) return
          this.history = entries
            .filter(entry => entry !== null && typeof entry === 'object')
            .filter(entry => entry.role === 'user' || entry.role === 'assistant')
            .filter(entry => typeof entry.text === 'string' && entry.text.trim() !== '')
            .map(entry => ({ role: entry.role, text: entry.text }))
          this.emit()
        } catch {
          /* history is optional; a failure never blocks the panel */
        }
      }

      /** Delete the stored transcript and the in-memory copy. */
      async clearHistory() {
        try {
          await fetch('/moss-live/history', { method: 'DELETE', credentials: 'same-origin' })
        } catch {
          /* the local copy is cleared regardless */
        }
        this.history = []
        this.emit()
      }

      /** Read key state over HTTP so it also works before the voice socket exists. */
      requestKeyStatus() {
        return this.keyRequest('GET')
      }

      /** Persist a key typed in the panel. */
      saveKey(value) {
        return this.keyRequest('POST', { action: 'set', key: value })
      }

      /** Remove the plugin-owned key file. */
      clearKey() {
        return this.keyRequest('POST', { action: 'clear' })
      }

      /** Call the same-origin key endpoint; the response never carries the secret. */
      async keyRequest(method, body) {
        try {
          const response = await fetch('/moss-live/key', {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          const data = await response.json()
          this.onKeyState(data ?? {})
          return data
        } catch (error) {
          const previous = this.keyState ?? { configured: false, masked: '', source: 'none', path: '' }
          this.onKeyState({ ...previous, error: '无法访问本机密钥接口：' + String(error?.message ?? error) })
          return undefined
        }
      }

      /** Adopt key state pushed by the host. */
      onKeyState(data) {
        this.keyState = {
          configured: data.configured === true,
          masked: typeof data.masked === 'string' ? data.masked : '',
          source: typeof data.source === 'string' ? data.source : 'none',
          path: typeof data.path === 'string' ? data.path : '',
          error: typeof data.error === 'string' ? data.error : '',
        }
        this.emit()
      }

      /** Deterministic entry: hand a typed request straight to the DSH runner. */
      submitTask(objective) {
        const text = typeof objective === 'string' ? objective.trim() : ''
        if (text === '' || this.socket === null) return false
        this.send({ action: 'dshTask', objective: text })
        this.notice = '已交给 DSH 后台执行'
        this.task = { title: clip(text, 32), status: '执行中' }
        this.emit()
        return true
      }

      sendMoss(payload) {
        return this.send({ action: 'moss', data: payload })
      }

      sendMossAll(messages) {
        for (const message of messages) this.sendMoss(message)
      }

      onCarrierMessage(event) {
        if (typeof event.data !== 'string') {
          this.onAudioFrame(event.data)
          return
        }
        const message = JSON.parse(event.data)
        if (message === null || typeof message !== 'object') return
        if (message.type === 'status') {
          this.onStatus(message.data ?? {})
          return
        }
        if (message.type === 'task') {
          this.onTask(message.data ?? {})
          return
        }
        if (message.type === 'key') {
          this.onKeyState(message.data ?? {})
          return
        }
        if (message.type === 'taskResult') {
          const text = message.data !== null && typeof message.data === 'object' ? message.data.text : ''
          if (typeof text === 'string' && text !== '') {
            this.reply = clip(text, 80)
            this.emit()
          }
          return
        }
        if (message.type === 'moss') this.onMossFrame(message.data ?? {})
      }

      onStatus(data) {
        const state = typeof data.state === 'string' ? data.state : 'idle'
        const message = typeof data.message === 'string' ? data.message : ''
        this.phase = state
        if (state === 'error') {
          this.statusText = message === '' ? '上游出错' : message
          this.notice = this.statusText
          this.disableInput()
        } else if (state === 'live') {
          this.statusText = message === '' ? '会话已建立' : message
          this.notice = ''
        } else if (state === 'connecting') {
          this.statusText = message === '' ? '正在连接上游…' : message
        } else {
          this.statusText = message === '' ? '空闲' : message
        }
        this.emit()
      }

      onTask(data) {
        const rawTitle = typeof data.title === 'string' ? data.title.trim() : ''
        const status = TASK_LABELS[data.status] ?? String(data.status ?? '')
        this.task = { title: rawTitle === '' ? '后台任务' : rawTitle, status }
        this.emit()
      }

      // ---- MOSS events -------------------------------------------------------------------------

      onMossFrame(frame) {
        const action = typeof frame.action === 'string' ? frame.action : ''
        const data = frame.data !== null && typeof frame.data === 'object' ? frame.data : {}
        if (action === 'session_attached') {
          this.onSessionAttached(data)
          return
        }
        if (action === 'session.updated') {
          this.onSessionUpdated(data)
          return
        }
        if (action === 'response.audio.started') {
          this.onAudioStarted(data)
          return
        }
        if (action === 'response.audio.context') {
          this.onAudioContext(data)
          return
        }
        if (action === 'response.audio.done') {
          this.onAudioDone(data)
          return
        }
        if (action === 'response.audio.stop') {
          this.onAudioStop(data)
          return
        }
        if (action === 'response.interrupted') {
          this.onInterrupted(data)
          return
        }
        if (action === 'response.ended') {
          this.reply = RESPONSE_LABELS[data.status] ?? String(data.status ?? '')
          this.typing = false
          this.aiSpeaking = false
          this.inputText = ''
          this.emit()
          return
        }
        if (action === 'input.transcript.updated') {
          if (typeof data.text === 'string') {
            this.inputText = data.text
            this.emit()
          }
          return
        }
        if (action === 'input.transcript.done' || action === 'input.transcript.revised') {
          if (typeof data.text === 'string' && data.text.trim() !== '') {
            this.commitHistory('user', data.text, String(data.turn ?? ''))
          }
          this.inputText = ''
          this.emit()
          return
        }
        if (action === 'output.transcript.updated') {
          if (typeof data.text === 'string') {
            this.outputText = data.text
            this.typing = false
            this.emit()
          }
          return
        }
        if (action === 'output.transcript.done') {
          if (typeof data.text === 'string' && data.text.trim() !== '') {
            this.commitHistory('assistant', data.text, String(data.run_id ?? ''))
          }
          this.outputText = ''
          this.typing = false
          this.emit()
          return
        }
        if (action === 'error') {
          const code = data.error !== null && typeof data.error === 'object'
            ? (data.error.code ?? 'unknown')
            : (data.error ?? 'unknown')
          this.setNotice('语音服务错误：' + String(code))
        }
      }

      /**
       * Append one finished turn to the transcript bubbles, replacing the
       * previous entry when the provider re-confirms the same turn id.
       */
      commitHistory(role, text, key) {
        const previous = this.history[this.history.length - 1]
        const previousKey = role === 'user' ? this.lastUserTurn : this.lastReplyRun
        if (previous !== undefined && previous.role === role && key !== '' && key === previousKey) {
          previous.text = text
          return
        }
        this.history.push({ role, text })
        if (role === 'user') this.lastUserTurn = key
        else this.lastReplyRun = key
        if (this.history.length > 12) this.history.splice(0, this.history.length - 12)
      }

      /** The host owns media.mode + session.update, so this side only records the session id. */
      onSessionAttached(data) {
        if (typeof data.session_id === 'string') this.sessionId = data.session_id
        this.phase = 'live'
        this.statusText = '会话已建立，等待会话配置'
        this.stoppedRunIds.clear()
        this.emit()
      }

      /** Only a clean session.updated may open the microphone. */
      onSessionUpdated(data) {
        const error = data.error
        if (error !== undefined && error !== null && error !== '') {
          this.statusText = '会话配置失败'
          this.notice = '会话配置失败：' + String(error)
          this.disableInput()
          this.emit()
          return
        }
        this.notice = ''
        this.statusText = this.muted ? '可以说话了（已静音）' : '可以说话了'
        if (this.mic !== null) {
          this.sendMoss({ action: 'mic_state', enabled: !this.muted })
          this.emit()
          return
        }
        void this.openMicrophone()
      }

      onAudioStarted(data) {
        this.aiSpeaking = true
        const runId = typeof data.run_id === 'string' ? data.run_id : ''
        this.activeRunId = runId
        if (runId === '') return
        this.stoppedRunIds.delete(runId)
        this.reply = ''
        if (this.ledger !== null) this.ledger.onStart(runId, data.turn_id)
        this.emit()
      }

      onAudioContext(data) {
        if (this.playbackCtx === null) return
        this.contexts.push({
          chunkId: typeof data.chunk_id === 'string' ? data.chunk_id : '',
          runId: typeof data.run_id === 'string' ? data.run_id : '',
          turnId: typeof data.turn_id === 'string' ? data.turn_id : '',
        })
        if (this.contexts.length <= MAX_CONTEXTS) return
        this.contexts = []
        this.setNotice('音频上下文积压，已丢弃当前播放队列')
      }

      /** One binary frame per context; the context is consumed even when its run is already dead. */
      onAudioFrame(data) {
        const context = this.contexts.shift()
        if (context === undefined) {
          if (this.playbackCtx !== null) this.setNotice('收到音频帧但没有对应的上下文')
          return
        }
        if (this.stoppedRunIds.has(context.runId)) return
        const ledger = this.ledger
        const speaker = this.speaker
        if (ledger === null || speaker === null) return
        const byteLength = data instanceof ArrayBuffer ? data.byteLength : (data?.byteLength ?? 0)
        if (byteLength === 0) return
        try {
          ledger.onContext(context)
          ledger.onAudio(byteLength, data)
          speaker.schedule()
        } catch (error) {
          this.setNotice('播放调度失败：' + describeError(error))
        }
      }

      onAudioDone(data) {
        const runId = typeof data.run_id === 'string' ? data.run_id : ''
        if (runId === '' || this.stoppedRunIds.has(runId)) return
        if (this.ledger === null) return
        this.sendMossAll(this.ledger.onFinished(runId, data.turn_id))
      }

      /** Server-requested barge-in: stop playback now and answer with playback.stopped. */
      onAudioStop(data) {
        const runId = typeof data.run_id === 'string' ? data.run_id : ''
        if (runId === '') return
        this.stoppedRunIds.add(runId)
        if (this.speaker !== null) this.speaker.stopScope(runId)
        if (this.ledger !== null) {
          this.sendMossAll(this.ledger.onStop(runId, data.turn_id, data.reason).messages)
        }
        this.capStoppedRuns()
      }

      /** Terminal interruption: stop audio, send no further receipts for this run. */
      onInterrupted(data) {
        this.typing = false
        this.aiSpeaking = false
        const runId = typeof data.run_id === 'string' && data.run_id !== '' ? data.run_id : this.activeRunId
        if (runId === '') return
        this.stoppedRunIds.add(runId)
        if (this.speaker !== null) this.speaker.stopScope(runId)
        if (this.ledger !== null) this.ledger.onInterrupted(runId, data.turn_id)
        this.reply = '被打断'
        this.capStoppedRuns()
        this.emit()
      }

      capStoppedRuns() {
        if (this.stoppedRunIds.size > 512) this.stoppedRunIds.clear()
      }

      // ---- capture -----------------------------------------------------------------------------

      /** Stop sending frames but keep the session's answer capability intact. */
      disableInput() {
        if (this.mic === null) return
        this.micSending = false
        this.muted = true
        this.sendMoss({ action: 'mic_state', enabled: false })
      }

      async openMicrophone() {
        if (this.disposed || this.micOpening || this.mic !== null || this.socket === null) return
        if (window.isSecureContext === false) {
          this.setNotice('需要 https 或 localhost 才能使用麦克风')
          return
        }
        const generation = this.generation
        this.micOpening = true
        try {
          const captureCtx = new AudioContext()
          this.micCtx = captureCtx
          if (captureCtx.audioWorklet === undefined) throw new Error('AudioWorklet 不可用')
          await captureCtx.resume()
          const mic = await Microphone.open({
            ctx: captureCtx,
            onFrame: (frame) => this.onMicFrame(frame),
          })
          if (this.generation !== generation || this.disposed) {
            mic.close()
            this.closeMicrophone()
            return
          }
          this.mic = mic
          await mic.start()
          if (this.generation !== generation || this.disposed) {
            this.closeMicrophone()
            return
          }
          this.micOpen = true
          this.micSending = !this.muted
          this.lastFrameAt = nowMS()
          this.micTimer = setInterval(() => this.pushSilence(), 25)
          if (this.micSending) this.sendMoss({ action: 'mic_state', enabled: true })
          this.statusText = '可以说话了'
          this.emit()
        } catch (error) {
          this.setNotice('麦克风不可用：' + describeMicFailure(error))
          this.closeMicrophone()
        } finally {
          this.micOpening = false
        }
      }

      closeMicrophone() {
        if (this.micTimer !== null) {
          clearInterval(this.micTimer)
          this.micTimer = null
        }
        const mic = this.mic
        this.mic = null
        if (mic !== null) {
          try {
            mic.close()
          } catch {
            /* capture already closed */
          }
        }
        const captureCtx = this.micCtx
        this.micCtx = null
        if (captureCtx !== null && captureCtx.state !== 'closed') {
          void captureCtx.close().catch(() => {})
        }
        this.micSending = false
        this.micOpen = false
        this.level = 0
        this.aiSpeaking = false
      }

      onMicFrame(pcm) {
        if (!this.micSending || this.mic === null) return
        this.meter(pcm)
        this.sendFrame(pcm)
      }

      /** Track a smoothed input level for the dock visualiser, at ~12 fps. */
      meter(pcm) {
        const samples = new Int16Array(pcm)
        let sum = 0
        const step = 4
        let count = 0
        for (let i = 0; i < samples.length; i += step) {
          const value = samples[i] / 32768
          sum += value * value
          count += 1
        }
        const rms = count === 0 ? 0 : Math.sqrt(sum / count)
        const scaled = Math.min(1, rms * 6)
        this.level = this.level * 0.6 + scaled * 0.4
        const now = nowMS()
        if (now - this.levelAt >= 80) {
          this.levelAt = now
          this.emit()
        }
      }

      sendFrame(pcm) {
        const socket = this.socket
        if (socket === null || socket.readyState !== WebSocket.OPEN) return
        try {
          socket.send(tagFrame(pcm))
          this.lastFrameAt = nowMS()
        } catch {
          /* a dying socket drops the frame; the watchdog keeps pacing */
        }
      }

      /** The worklet stops producing blocks when the graph stalls, so pad the uplink with silence. */
      pushSilence() {
        if (!this.micSending || this.mic === null) return
        const elapsed = nowMS() - this.lastFrameAt
        if (elapsed < MIC_FRAME_MS) return
        const count = Math.min(5, Math.max(1, Math.floor(elapsed / MIC_FRAME_MS)))
        const silent = new Int16Array(MIC_FRAME_SAMPLES).buffer
        for (let i = 0; i < count; i += 1) this.sendFrame(silent)
      }
    }

    // ---------------------------------------------------------------------------------------------
    // Shared engine: the sidebar button and the right-column panel share one session.
    // ---------------------------------------------------------------------------------------------

    /** Tab kind and registry id for this plugin's right-column page. */
    const TAB_ID = 'moss-live-voice'

    let pluginCtx = null
    let engineInstance = null
    let latestView = INITIAL_VIEW
    const subscribers = new Set()

    /** One engine per page; both entry points subscribe to the same instance. */
    function voiceEngine() {
      if (engineInstance === null) {
        engineInstance = new VoiceEngine((view) => {
          latestView = view
          for (const notify of subscribers) notify(view)
        })
      }
      return engineInstance
    }

    /** Subscribe a component to engine view updates. */
    function useVoiceView() {
      const [view, setView] = React.useState(latestView)
      React.useEffect(() => {
        subscribers.add(setView)
        setView(latestView)
        return () => {
          subscribers.delete(setView)
        }
      }, [])
      return view
    }

    // ---------------------------------------------------------------------------------------------
    // View layer: Linear/Arc-flavoured shell with a floating voice dock.
    // ---------------------------------------------------------------------------------------------

    /** Stylesheet for the panel; scoped by class so it cannot leak into the app shell. */
    const WIDTH = '720px'
    const CENTER = 'width:100%;max-width:' + WIDTH + ';margin-left:auto;margin-right:auto;box-sizing:border-box'

    const PANEL_CSS = [
      '.moss-root{',
      '--moss-bg:linear-gradient(180deg,#F8FAFC,#EEF2F7);',
      '--moss-surface:rgba(255,255,255,.74);',
      '--moss-card:rgba(255,255,255,.92);',
      '--moss-border:rgba(15,23,42,.08);',
      '--moss-hairline:rgba(0,0,0,.06);',
      '--moss-text:#0F172A;',
      '--moss-sub:#64748B;',
      '--moss-accent:#6366F1;',
      '--moss-accent-2:#4F46E5;',
      '--moss-emerald:#10B981;',
      '--moss-amber:#F59E0B;',
      '--moss-red:#EF4444;',
      '--moss-bubble:rgba(255,255,255,.92);',
      '--moss-shadow:0 12px 32px rgba(15,23,42,.08);',
      'position:relative;display:flex;flex-direction:column;height:100%;min-height:0;',
      'overflow:hidden;padding:0 14px;color:var(--moss-text);background:var(--moss-bg);',
      'font-size:12px;line-height:1.65;font-variant-numeric:tabular-nums;',
      '-webkit-font-smoothing:antialiased}',
      '.moss-root *{box-sizing:border-box}',
      '.moss-root[data-moss-theme="dark"]{',
      '--moss-bg:linear-gradient(180deg,#0B0F14,#111823);',
      '--moss-surface:rgba(255,255,255,.05);',
      '--moss-card:rgba(26,31,40,.94);',
      '--moss-border:rgba(255,255,255,.09);',
      '--moss-hairline:rgba(255,255,255,.08);',
      '--moss-text:#E6EDF3;',
      '--moss-sub:#94A3B8;',
      '--moss-bubble:rgba(255,255,255,.055);',
      '--moss-shadow:0 12px 32px rgba(0,0,0,.42)}',
      '.moss-center{' + CENTER + '}',
      '.moss-header{position:relative;z-index:3;' + CENTER + ';display:flex;align-items:center;',
      'gap:8px;padding:12px 2px 10px;background:transparent;border:none;border-radius:0;',
      'border-bottom:1px solid var(--moss-hairline);box-shadow:none}',
      '.moss-brand{display:flex;align-items:center;gap:7px;min-width:0}',
      '.moss-name{font-size:12.5px;font-weight:600;letter-spacing:.2px;white-space:nowrap}',
      '.moss-badge{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;',
      'color:var(--moss-sub);background:color-mix(in srgb,var(--moss-sub) 10%,transparent);',
      'border:none;letter-spacing:.2px;flex:0 0 auto}',
      '.moss-status{margin-left:2px;color:var(--moss-sub);font-size:11.5px;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      '.moss-spacer{flex:1 1 auto}',
      '.moss-dot{position:relative;width:8px;height:8px;border-radius:999px;flex:0 0 auto;',
      'background:var(--moss-sub);transition:background .2s}',
      '.moss-dot[data-state="idle"]{background:#94A3B8;animation:mossBreathe 3.6s ease-in-out infinite}',
      '.moss-dot[data-state="live"]{background:var(--moss-emerald);',
      'box-shadow:0 0 0 4px color-mix(in srgb,var(--moss-emerald) 18%,transparent);',
      'animation:mossBreathe 2.4s ease-in-out infinite}',
      '.moss-dot[data-state="ai"]{background:var(--moss-accent);',
      'box-shadow:0 0 0 4px color-mix(in srgb,var(--moss-accent) 20%,transparent);',
      'animation:mossRipple 1.8s ease-out infinite}',
      '.moss-dot[data-state="error"]{background:var(--moss-red)}',
      '@keyframes mossBreathe{0%,100%{opacity:.45}50%{opacity:1}}',
      '@keyframes mossRipple{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--moss-accent) 36%,transparent)}',
      '100%{box-shadow:0 0 0 11px transparent}}',
      '.moss-transcript{' + CENTER + ';position:relative;flex:1 1 auto;min-height:0;',
      'overflow-y:auto;scroll-behavior:smooth;padding:16px 2px 10px;',
      'mask-image:linear-gradient(to bottom,transparent 0,#000 18px,#000 calc(100% - 20px),transparent 100%);',
      '-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 18px,',
      '#000 calc(100% - 20px),transparent 100%)}',
      '.moss-thread{display:flex;flex-direction:column;gap:14px;width:100%}',
      '.moss-msg{display:flex;gap:8px;align-items:flex-start;width:100%}',
      '.moss-msg.user{justify-content:flex-end;align-items:flex-end}',
      '.moss-msg.ai{align-items:flex-start}',
      '.moss-avatar{width:28px;height:28px;flex:0 0 auto;flex-shrink:0;margin-top:2px;',
      'border-radius:999px;display:flex;align-items:center;justify-content:center;color:#fff;',
      'background:linear-gradient(135deg,var(--moss-accent),#8B5CF6);',
      'box-shadow:0 2px 10px color-mix(in srgb,var(--moss-accent) 40%,transparent)}',
      '.moss-bubble{max-width:78%;padding:10px 14px;border-radius:18px;font-size:13px;',
      'line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;transition:opacity .2s ease}',
      '.moss-bubble .moss-p{margin:0 0 10px}',
      '.moss-bubble .moss-p:last-child{margin-bottom:0}',
      '.moss-bubble.user{background:linear-gradient(135deg,var(--moss-accent),var(--moss-accent-2));',
      'color:#fff;border-bottom-right-radius:6px;',
      'box-shadow:0 8px 20px color-mix(in srgb,var(--moss-accent-2) 28%,transparent)}',
      '.moss-bubble.ai{background:var(--moss-bubble);border:1px solid var(--moss-border);',
      'color:var(--moss-text);border-bottom-left-radius:6px;box-shadow:0 2px 10px rgba(15,23,42,.05)}',
      '.moss-bubble.live{opacity:.72}',
      '.moss-bubble.live.user{font-style:italic}',
      '.moss-typing{display:inline-flex;gap:4px;padding:12px 14px}',
      '.moss-typing span{width:6px;height:6px;border-radius:999px;background:var(--moss-sub);',
      'animation:mossType 1.2s ease-in-out infinite}',
      '.moss-typing span:nth-child(2){animation-delay:.16s}',
      '.moss-typing span:nth-child(3){animation-delay:.32s}',
      '@keyframes mossType{0%,60%,100%{opacity:.25;transform:translateY(0)}',
      '30%{opacity:1;transform:translateY(-2px)}}',
      '.moss-empty{margin:auto;display:flex;flex-direction:column;align-items:center;gap:9px;',
      'color:var(--moss-sub);padding:28px 16px;text-align:center;max-width:340px}',
      '.moss-empty-badge{width:46px;height:46px;border-radius:16px;display:flex;',
      'align-items:center;justify-content:center;color:var(--moss-accent);',
      'background:color-mix(in srgb,var(--moss-accent) 10%,transparent);',
      'border:1px solid color-mix(in srgb,var(--moss-accent) 22%,transparent)}',
      '.moss-empty-title{font-size:13px;font-weight:600;color:var(--moss-text)}',
      '.moss-empty-hint{font-size:11.5px}',
      '.moss-notice{' + CENTER + ';display:flex;align-items:center;gap:6px;padding:0 2px 8px;',
      'color:var(--moss-red);font-size:11.5px;overflow-wrap:anywhere}',
      '.moss-taskcard{' + CENTER + ';display:flex;align-items:center;gap:8px;padding:8px 14px;',
      'margin-bottom:12px;background:rgba(255,255,255,.85);border:1px solid #E2E8F0;',
      'border-radius:12px}',
      '.moss-root[data-moss-theme="dark"] .moss-taskcard{background:rgba(255,255,255,.05);',
      'border-color:rgba(255,255,255,.1)}',
      '.moss-task-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;font-size:11.5px;color:var(--moss-sub)}',
      '.moss-reply{' + CENTER + ';padding:0 2px 8px;font-size:11.5px;color:var(--moss-sub)}',
      '.moss-chip{flex-shrink:0;border:1px solid var(--moss-border);border-radius:999px;',
      'padding:0 8px;font-size:10.5px;line-height:18px;color:var(--moss-sub);white-space:nowrap}',
      '.moss-chip[data-tone="ok"]{color:var(--moss-emerald);',
      'border-color:color-mix(in srgb,var(--moss-emerald) 40%,transparent)}',
      '.moss-chip[data-tone="warn"]{color:var(--moss-amber);',
      'border-color:color-mix(in srgb,var(--moss-amber) 40%,transparent)}',
      '.moss-chip[data-tone="bad"]{color:var(--moss-red);',
      'border-color:color-mix(in srgb,var(--moss-red) 40%,transparent)}',
      '.moss-dock-wrap{' + CENTER + ';padding:6px 2px 14px;display:flex;justify-content:center}',
      '.moss-dock{width:fit-content;margin:0 auto;display:flex;align-items:center;',
      'justify-content:center;gap:12px;padding:10px 18px;',
      'border:1px solid var(--moss-border);border-radius:999px;',
      'background:var(--moss-surface);backdrop-filter:blur(16px);',
      '-webkit-backdrop-filter:blur(16px);box-shadow:var(--moss-shadow)}',
      '.moss-dock-hint{color:var(--moss-sub);font-size:11.5px;padding:0 2px}',
      '.moss-btn{appearance:none;border:1px solid var(--moss-border);background:transparent;',
      'color:var(--moss-text);border-radius:999px;padding:8px 14px;font-size:12px;cursor:pointer;',
      'display:inline-flex;align-items:center;gap:6px;transition:all .2s ease;white-space:nowrap}',
      '.moss-btn:hover{background:color-mix(in srgb,var(--moss-text) 6%,transparent)}',
      '.moss-btn:active{transform:scale(.95)}',
      '.moss-btn:disabled{opacity:.45;cursor:default}',
      '.moss-btn-primary{border-color:transparent;color:#fff;',
      'background:linear-gradient(135deg,#111827,#1F2937);',
      'box-shadow:0 8px 20px rgba(15,23,42,.24)}',
      '.moss-root[data-moss-theme="dark"] .moss-btn-primary{',
      'background:linear-gradient(135deg,#6366F1,#4F46E5);',
      'box-shadow:0 8px 20px rgba(79,70,229,.34)}',
      '.moss-btn-primary:hover{filter:brightness(1.06)}',
      '.moss-btn-mute[data-muted="true"]{color:#B45309;',
      'border-color:color-mix(in srgb,var(--moss-amber) 46%,transparent);',
      'background:color-mix(in srgb,var(--moss-amber) 12%,transparent)}',
      '.moss-root[data-moss-theme="dark"] .moss-btn-mute[data-muted="true"]{color:#FBBF24}',
      '.moss-btn-danger{border-color:transparent;color:#fff;',
      'background:linear-gradient(135deg,#EF4444,#DC2626);',
      'box-shadow:0 8px 20px rgba(239,68,68,.3)}',
      '.moss-icon-btn{appearance:none;border:1px solid transparent;background:transparent;',
      'color:var(--moss-sub);width:28px;height:28px;border-radius:9px;display:flex;',
      'align-items:center;justify-content:center;cursor:pointer;transition:all .2s ease;flex:0 0 auto}',
      '.moss-icon-btn:hover{background:color-mix(in srgb,var(--moss-text) 7%,transparent);',
      'color:var(--moss-text)}',
      '.moss-icon-btn:active{transform:scale(.92)}',
      '.moss-viz{display:flex;align-items:center;gap:3px;height:26px;padding:0 4px}',
      '.moss-bar{width:3px;border-radius:999px;',
      'background:linear-gradient(180deg,var(--moss-accent),var(--moss-accent-2));',
      'transition:height .09s linear,opacity .2s ease;transform-origin:center}',
      '.moss-viz[data-state="muted"] .moss-bar{background:var(--moss-sub);opacity:.4}',
      '.moss-viz[data-state="idle"] .moss-bar{background:var(--moss-sub);opacity:.3}',
      '.moss-viz[data-state="ai"] .moss-bar{animation:mossBars 1.1s ease-in-out infinite}',
      '.moss-viz[data-state="ai"] .moss-bar:nth-child(2){animation-delay:.1s}',
      '.moss-viz[data-state="ai"] .moss-bar:nth-child(3){animation-delay:.22s}',
      '.moss-viz[data-state="ai"] .moss-bar:nth-child(4){animation-delay:.05s}',
      '.moss-viz[data-state="ai"] .moss-bar:nth-child(5){animation-delay:.18s}',
      '.moss-viz[data-state="ai"] .moss-bar:nth-child(6){animation-delay:.28s}',
      '.moss-viz[data-state="ai"] .moss-bar:nth-child(7){animation-delay:.12s}',
      '@keyframes mossBars{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}',
      '.moss-modal{position:absolute;inset:0;z-index:9;display:flex;align-items:center;',
      'justify-content:center;padding:18px;background:rgba(15,23,42,.26);',
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:mossFade .18s ease}',
      '.moss-card{width:100%;max-width:360px;max-height:100%;overflow-y:auto;border-radius:16px;',
      'border:1px solid var(--moss-border);background:var(--moss-card);padding:16px;',
      'display:flex;flex-direction:column;gap:12px;color:var(--moss-text);',
      'box-shadow:0 28px 70px rgba(15,23,42,.3);backdrop-filter:blur(20px)}',
      '.moss-card-head{display:flex;align-items:center;gap:8px}',
      '.moss-card-title{flex:1 1 auto;font-size:13px;font-weight:600}',
      '.moss-field{display:flex;flex-direction:column;gap:6px}',
      '.moss-label{font-size:11px;color:var(--moss-sub);letter-spacing:.3px}',
      '.moss-input{width:100%;padding:8px 10px;border-radius:10px;',
      'border:1px solid var(--moss-border);',
      'background:color-mix(in srgb,var(--moss-text) 4%,transparent);color:var(--moss-text);',
      'font-size:12px;outline:none;transition:border-color .2s,box-shadow .2s}',
      '.moss-input:focus{border-color:var(--moss-accent);',
      'box-shadow:0 0 0 3px color-mix(in srgb,var(--moss-accent) 18%,transparent)}',
      '.moss-row{display:flex;gap:8px;align-items:center}',
      '.moss-row .moss-input{flex:1 1 auto;min-width:0}',
      '.moss-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--moss-sub);',
      'overflow-wrap:anywhere}',
      '.moss-error{color:var(--moss-red);font-size:11.5px;overflow-wrap:anywhere}',
      '.moss-note{font-size:11px;color:var(--moss-sub);line-height:1.55}',
      '@keyframes mossFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    ].join('\n')

    const KEY_SOURCE_LABELS = {
      'config-file': '配置文件指定',
      'key-file': '本机密钥文件',
      env: '环境变量',
      none: '未配置',
    }

    /** Transport phrase for the header, one place instead of two redundant labels. */
    function statusText(view) {
      if (view.phase === 'error') return '连接出错'
      if (view.socketState === 'closed') return '未连接'
      if (view.phase === 'connecting') return '连接中'
      if (view.muted) return '已静音'
      if (view.aiSpeaking) return 'MOSS 正在回答'
      if (!view.micOpen) return '正在打开麦克风'
      return '正在聆听'
    }

    /** Indicator state: idle / live / ai / error. */
    function dotState(view) {
      if (view.phase === 'error') return 'error'
      if (view.socketState === 'closed') return 'idle'
      if (view.phase === 'connecting') return 'idle'
      if (view.aiSpeaking) return 'ai'
      return 'live'
    }

    function GearGlyph({ size = 15 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('circle', { cx: 8, cy: 8, r: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', {
        d: 'M8 1.7v1.4M8 12.9v1.4M1.7 8h1.4M12.9 8h1.4M3.5 3.5l1 1M11.5 12.5l1 1'
          + 'M12.5 3.5l-1 1M4.5 12.5l-1 1',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }))
    }

    function MicGlyph({ size = 15 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('rect', {
        x: 6, y: 2, width: 4, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.3,
      }),
      h('path', {
        d: 'M3.8 7.4a4.2 4.2 0 0 0 8.4 0M8 11.6V14M5.8 14h4.4',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }))
    }

    function MicOffGlyph({ size = 15 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('rect', {
        x: 6, y: 2, width: 4, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.3,
      }),
      h('path', {
        d: 'M3.8 7.4a4.2 4.2 0 0 0 8.4 0M8 11.6V14M5.8 14h4.4M2.6 2.6l10.8 10.8',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }))
    }

    function HangupGlyph({ size = 15 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2.4 4.9c3.4-2.6 7.8-2.6 11.2 0 .5.4.5 1 .2 1.5l-1.2 1.5'
          + 'c-.3.4-.9.5-1.3.3l-1.7-.8a1 1 0 0 1-.5-1.2l.2-.7c-1.4-.5-2.9-.5-4.3 0l.2.7'
          + 'a1 1 0 0 1-.5 1.2l-1.7.8c-.4.2-1 .1-1.3-.3L2.2 6.4c-.3-.5-.3-1.1.2-1.5Z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }))
    }

    function CloseGlyph({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('path', {
        d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }))
    }

    /** Waveform glyph shared by the transcript avatar and the sidebar entry. */
    function VoiceGlyph({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', style: { display: 'block' },
      },
      h('path', {
        d: 'M4 6v4M8 3v10M12 5.5v5',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
      }))
    }

    /** Floating top bar: one status phrase, one settings icon. */
    function Header({ view, onSettings }) {
      return h('div', { className: 'moss-header' },
        h('span', { className: 'moss-dot', 'data-state': dotState(view) }),
        h('span', { className: 'moss-brand' },
          h('span', { className: 'moss-name' }, 'MOSS-Live DSH'),
          h('span', { className: 'moss-badge' }, 'VOICE'),
        ),
        h('span', { className: 'moss-status' }, statusText(view)),
        h('span', { className: 'moss-spacer' }),
        h('button', {
          className: 'moss-icon-btn',
          type: 'button',
          title: '设置',
          'aria-label': '设置',
          onClick: onSettings,
        }, h(GearGlyph, { size: 15 })),
      )
    }

    /** Split reply text on blank lines so paragraphs get their own spacing. */
    function paragraphsOf(text) {
      return String(text).split(/\n{2,}/).filter(part => part.trim() !== '')
    }

    /** One transcript bubble; live text is dimmed (and italic while still unconfirmed). */
    function Bubble({ role, text, live }) {
      const isUser = role === 'user'
      const parts = paragraphsOf(text)
      const body = parts.length <= 1
        ? text
        : parts.map((part, index) => h('p', { key: index, className: 'moss-p' }, part))
      return h('div', { className: 'moss-msg ' + role },
        isUser ? null : h('div', { className: 'moss-avatar' }, h(VoiceGlyph, { size: 15 })),
        h('div', { className: 'moss-bubble ' + role + (live ? ' live' : '') }, body),
      )
    }

    /** Three-dot bubble while the reply is being produced. */
    function TypingBubble() {
      return h('div', { className: 'moss-msg ai' },
        h('div', { className: 'moss-avatar' }, h(VoiceGlyph, { size: 15 })),
        h('div', { className: 'moss-bubble ai moss-typing' },
          h('span'), h('span'), h('span')),
      )
    }

    const BAR_WEIGHTS = [0.5, 0.9, 0.68, 1, 0.74, 0.95, 0.58]

    /** Seven-bar level meter; falls back to a CSS pulse while MOSS speaks. */
    function Visualizer({ view }) {
      const state = view.socketState === 'closed'
        ? 'idle'
        : view.muted ? 'muted' : view.aiSpeaking ? 'ai' : 'live'
      return h('div', { className: 'moss-viz', 'data-state': state },
        BAR_WEIGHTS.map((weight, index) => {
          const height = state === 'ai'
            ? 20
            : Math.max(4, Math.round(4 + view.level * 30 * weight))
          return h('span', {
            key: index,
            className: 'moss-bar',
            style: { height: height + 'px' },
          })
        }),
      )
    }

    /** Bottom capsule: connect when idle, meters + mute + hang up otherwise. */
    function Dock({ view, engine }) {
      const connected = view.socketState !== 'closed'
      if (!connected) {
        return h('div', { className: 'moss-dock-wrap' },
          h('div', { className: 'moss-dock' },
            h('span', { className: 'moss-dock-hint' }, '点击连接，开启实时语音对话'),
            h('button', {
              className: 'moss-btn moss-btn-primary',
              type: 'button',
              onClick: () => engine.connect(),
            }, h(MicGlyph, { size: 14 }), '连接'),
          ),
        )
      }
      return h('div', { className: 'moss-dock-wrap' },
        h('div', { className: 'moss-dock' },
          h(Visualizer, { view }),
          h('button', {
            className: 'moss-btn moss-btn-mute',
            type: 'button',
            'data-muted': view.muted ? 'true' : 'false',
            disabled: !view.micOpen,
            title: view.muted ? '取消静音' : '静音',
            onClick: () => engine.toggleMute(),
          },
          view.muted ? h(MicOffGlyph, { size: 14 }) : h(MicGlyph, { size: 14 }),
          view.muted ? '取消静音' : '静音'),
          h('button', {
            className: 'moss-btn moss-btn-danger',
            type: 'button',
            title: '断开',
            onClick: () => engine.disconnect(),
          }, h(HangupGlyph, { size: 14 }), '断开'),
        ),
      )
    }

    /** Settings sheet: key management plus the typed debug entry. */
    function SettingsSheet({ view, engine, onClose }) {
      const [keyDraft, setKeyDraft] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const key = view.keyState
      const connected = view.socketState !== 'closed'
      const save = () => {
        if (keyDraft.trim() === '') return
        engine.saveKey(keyDraft.trim())
        setKeyDraft('')
      }
      const submit = () => {
        if (engine.submitTask(draft)) setDraft('')
      }
      return h('div', {
        className: 'moss-modal',
        onClick: onClose,
      },
      h('div', {
        className: 'moss-card',
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { className: 'moss-card-head' },
        h('span', { className: 'moss-card-title' }, '设置'),
        h('button', {
          className: 'moss-icon-btn',
          type: 'button',
          title: '关闭',
          'aria-label': '关闭',
          onClick: onClose,
        }, h(CloseGlyph, { size: 14 })),
      ),
      h('div', { className: 'moss-field' },
        h('span', { className: 'moss-label' }, 'MOSS API KEY'),
        h('div', { className: 'moss-meta' },
          h('span', null, key !== null && key.configured ? '已配置 ' + key.masked : '未配置'),
          key !== null && key.configured
            ? h('span', { className: 'moss-chip' }, KEY_SOURCE_LABELS[key.source] ?? key.source)
            : null,
        ),
        h('div', { className: 'moss-row' },
          h('input', {
            className: 'moss-input',
            type: 'password',
            value: keyDraft,
            placeholder: '粘贴 MOSS API Key',
            autoComplete: 'off',
            spellCheck: false,
            onChange: event => setKeyDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            },
          }),
          h('button', {
            className: 'moss-btn moss-btn-primary',
            type: 'button',
            disabled: keyDraft.trim() === '',
            onClick: save,
          }, '保存'),
          key !== null && key.configured
            ? h('button', {
              className: 'moss-btn',
              type: 'button',
              onClick: () => engine.clearKey(),
            }, '清除')
            : null,
        ),
        key !== null && key.error !== '' ? h('div', { className: 'moss-error' }, key.error) : null,
        h('div', { className: 'moss-note' },
          '保存在本机密钥文件（权限 600），不回传浏览器；保存后点“连接”生效。'),
      ),
      h('div', { className: 'moss-field' },
        h('span', { className: 'moss-label' }, '对话历史'),
        h('div', { className: 'moss-meta' },
          h('span', null, '自动保存到本机，刷新或重启后仍在'),
          h('button', {
            className: 'moss-btn',
            type: 'button',
            onClick: () => {
              if (window.confirm('清空全部语音对话历史？')) void engine.clearHistory()
            },
          }, '清空历史'),
        ),
      ),
      h('div', { className: 'moss-field' },
        h('span', { className: 'moss-label' }, '调试直连（不经语音，不会朗读）'),
        h('div', { className: 'moss-row' },
          h('input', {
            className: 'moss-input',
            value: draft,
            placeholder: '例如：看看当前目录有什么',
            disabled: !connected,
            onChange: event => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            },
          }),
          h('button', {
            className: 'moss-btn',
            type: 'button',
            disabled: !connected || draft.trim() === '',
            onClick: submit,
          }, '执行'),
        ),
      ),
      ),
      )
    }

    /**
     * Resolve whether the page is currently dark by measuring the resolved base
     * surface, so the panel follows any DSH theme instead of one attribute name.
     * @returns {boolean} true when the page background is dark
     */
    function detectDarkPage() {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--dsw-alias-bg-base').trim()
      const parts = raw.match(/[\d.]+/g)
      if (parts === null || parts.length < 3) return false
      const [red, green, blue] = parts.slice(0, 3).map(Number)
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
      return luminance < 0.5
    }

    /** Right-column page. */
    function VoicePanel() {
      const view = useVoiceView()
      const engine = voiceEngine()
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [dark, setDark] = React.useState(false)
      const transcript = React.useRef(null)
      React.useEffect(() => {
        void engine.requestKeyStatus()
        void engine.loadHistory()
      }, [engine])
      React.useEffect(() => {
        const probe = () => setDark(detectDarkPage())
        probe()
        const observer = new MutationObserver(probe)
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
        })
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        media.addEventListener?.('change', probe)
        return () => {
          observer.disconnect()
          media.removeEventListener?.('change', probe)
        }
      }, [])
      const messageCount = view.history.length
        + (view.inputText === '' ? 0 : 1)
        + (view.outputText === '' ? 0 : 1)
      React.useEffect(() => {
        const element = transcript.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [messageCount, view.typing, view.outputText])

      const bubbles = view.history.slice()
      if (view.inputText !== '') bubbles.push({ role: 'user', text: view.inputText, live: true })
      if (view.outputText !== '') bubbles.push({ role: 'assistant', text: view.outputText, live: true })
      const keyMissing = view.keyState === null || view.keyState.configured !== true
      const taskTone = view.task === null
        ? 'none'
        : view.task.status === '已完成' ? 'ok'
          : view.task.status === '失败' ? 'bad' : 'warn'

      return h('div', { className: 'moss-root', 'data-moss-theme': dark ? 'dark' : 'light' },
        h('style', null, PANEL_CSS),
        h(Header, { view, onSettings: () => setSettingsOpen(true) }),
        h('div', { ref: transcript, className: 'moss-transcript' },
          h('div', { className: 'moss-thread' },
            bubbles.length === 0 && !view.typing
              ? h('div', { className: 'moss-empty' },
                h('div', { className: 'moss-empty-badge' }, h(VoiceGlyph, { size: 22 })),
                h('div', { className: 'moss-empty-title' }, '说一句话开始对话'),
                h('div', { className: 'moss-empty-hint' },
                  keyMissing
                    ? '还没有配置 API Key，点右上角齿轮填入，或用下方的本地回环测试。'
                    : '试试：“帮我看看当前目录下有哪些文件，用一句话告诉我”'),
              )
              : bubbles.map((item, index) => h(Bubble, {
                key: String(index) + item.role + item.text.length,
                role: item.role,
                text: item.text,
                live: item.live === true,
              })),
            view.typing && view.outputText === '' ? h(TypingBubble, null) : null,
          ),
        ),
        view.notice === '' ? null : h('div', { className: 'moss-notice' }, '⚠ ' + view.notice),
        view.task === null ? null : h('div', { className: 'moss-taskcard' },
          h('span', { className: 'moss-chip', 'data-tone': taskTone }, '后台 · ' + view.task.status),
          h('span', { className: 'moss-task-title' }, view.task.title),
        ),
        view.reply === '' ? null : h('div', { className: 'moss-reply' }, view.reply),
        h(Dock, { view, engine }),
        settingsOpen
          ? h(SettingsSheet, { view, engine, onClose: () => setSettingsOpen(false) })
          : null,
      )
    }

    /** Tab chip label. */
    function VoiceTabTitle() {
      return h('span', null, 'MOSS')
    }

    /** Sidebar-foot action that reveals the voice page. */
    function SidebarVoiceButton({ wide = true }) {
      const view = useVoiceView()
      const live = view.socketState !== 'closed'
      return h('button', {
        type: 'button',
        onClick: toggleVoicePanel,
        title: 'MOSS-Live DSH',
        'aria-label': 'MOSS-Live DSH',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          appearance: 'none', border: 'none', background: 'transparent', color: 'inherit',
          cursor: 'pointer', padding: wide ? '6px 8px' : '6px 0',
          borderRadius: 8, fontSize: 12, justifyContent: wide ? 'flex-start' : 'center',
        },
      },
      h('span', { style: { display: 'flex', color: live ? '#10B981' : 'inherit' } },
        h(VoiceGlyph, { size: wide ? 16 : 18 })),
      wide ? h('span', { style: { opacity: 0.85 } }, 'MOSS-Live') : null,
      )
    }

    /** Fallback entry for a harness without the right column. */
    function VoiceDockFallback() {
      const view = useVoiceView()
      const engine = voiceEngine()
      const connected = view.socketState !== 'closed'
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
        h('span', { style: { width: 7, height: 7, borderRadius: 999, background: '#10B981' } }),
        h('span', { style: { fontWeight: 600 } }, 'MOSS-Live DSH'),
        h('span', { style: { opacity: 0.7 } }, statusText(view)),
        h('button', {
          type: 'button',
          onClick: () => { if (connected) engine.disconnect(); else engine.connect() },
          style: {
            appearance: 'none', border: '1px solid currentColor', background: 'transparent',
            color: 'inherit', borderRadius: 999, padding: '3px 12px', fontSize: 12, cursor: 'pointer',
          },
        }, connected ? '断开' : '连接'),
      )
    }

    /**
     * Open (or focus) this plugin's page in the right column.
     * The column only draws while it is expanded, and the panel's own
     * presentation sync closes it when its store says collapsed, so the
     * controller's expansion state is the switch to use here.
     */
    function openVoicePanel() {
      const ctx = pluginCtx
      const panel = ctx?.sidebarRight
      if (panel === undefined) return
      try {
        panel.openTab(TAB_ID)
      } catch {
        /* no Session on screen: nothing to open into */
        return
      }
      let expanded = true
      try {
        expanded = typeof panel.isExpanded === 'function' ? panel.isExpanded() : true
      } catch {
        expanded = true
      }
      if (expanded) return
      try {
        panel.toggleExpanded()
      } catch {
        /* layout face unavailable */
      }
    }

    /** Reveal the page, or collapse the column when it already shows it. */
    function toggleVoicePanel() {
      const panel = pluginCtx?.sidebarRight
      if (panel === undefined) return
      let activeKind = ''
      let expanded = false
      try {
        activeKind = panel.active?.()?.kind ?? ''
        expanded = typeof panel.isExpanded === 'function' ? panel.isExpanded() : false
      } catch {
        activeKind = ''
        expanded = false
      }
      if (activeKind === TAB_ID && expanded) {
        try {
          panel.toggleExpanded()
        } catch {
          /* column already collapsed */
        }
        return
      }
      openVoicePanel()
    }

    return {
      // The right column's registry and navigation face must exist before mounting.
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        pluginCtx = ctx
        const tabs = ctx.sidebarRightTabs
        if (tabs !== undefined) {
          ctx.effect(() => tabs.register({
            id: TAB_ID,
            kind: TAB_ID,
            title: () => 'MOSS',
            multiple: false,
            keepMounted: true,
          }))
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: TAB_ID,
          }, VoicePanel))
          ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title', key: TAB_ID,
          }, VoiceTabTitle))
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action', id: TAB_ID, order: 10,
          }, SidebarVoiceButton))
          return
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: TAB_ID, order: 20,
        }, VoiceDockFallback))
      },
    }
  },
})
