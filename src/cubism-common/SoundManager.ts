import { logger, remove } from "@/utils";

interface AudioLoopHandle {
    readonly file: string;
    readonly loopStart: number;
    readonly loopEnd: number;
    readonly audioBuffer: AudioBuffer;
    readonly gain: GainNode;
    _stopped: boolean;
}

interface PreloadEntry {
    audioBuffer: AudioBuffer;
    loopStart: number;
    loopEnd: number;
}

const TAG = "SoundManager";
export const VOLUME = 0.5;

const audioListenersWeakMap = new WeakMap();
const audioCanplaythroughWeakMap = new WeakMap();
const audioAnalyserWeakMap = new WeakMap<HTMLAudioElement, AnalyserNode>();
const audioSourceWeakMap = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
const audioBufferSourceWeakMap = new WeakMap<AudioLoopHandle, AudioBufferSourceNode>();
const preloadMap = new Map<string, PreloadEntry>();

let audioContext: AudioContext | null = null;
/**
 * Manages all the sounds.
 */
export class SoundManager {
    /**
     * Audio elements playing or pending to play. Finished audios will be removed automatically.
     */
    static audios: HTMLAudioElement[] = [];
    static analysers: AnalyserNode[] = [];
    static loopHandles: AudioLoopHandle[] = [];

    protected static _volume = VOLUME;

    /**
     * Global volume that applies to all the sounds.
     */
    static get volume(): number {
        return this._volume;
    }

    static set volume(value: number) {
        this._volume = (value > 1 ? 1 : value < 0 ? 0 : value) || 0;
        this.audios.forEach((audio) => (audio.volume = this._volume));
        this.loopHandles.forEach((handle) => (handle.gain.gain.value = this._volume));
    }

    /**
     * Preload an opus file with vorbis loop tags LOOP_START and LOOP_END
     * Will generally work for other formats but tags might not
     * @param file - URL of the sound file.
     */
    static async preload(file: string): Promise<void> {
        if (preloadMap.has(file)) return;

        const context = this.getContext();

        let arrayBuffer: ArrayBuffer;
        let audioBuffer: AudioBuffer;
        try {
            const response = await fetch(file);
            arrayBuffer = await response.arrayBuffer();
            audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
        } catch (e) {
            logger.warn(TAG, `Failed to preload "${file}"`, e);
            throw e;
        }

        let loopStart = 0;
        let loopEnd = audioBuffer.duration;
        try {
            const decoder = new TextDecoder();
            const bytes = new Uint8Array(arrayBuffer, 0, Math.min(65536, arrayBuffer.byteLength));
            const view = new DataView(arrayBuffer);

            let sampleRate: number | undefined;
            let loopStartSample: number | undefined;
            let loopEndSample: number | undefined;

            for (let i = 0; i < bytes.length - 4; i++) {
                if (
                    bytes[i] !== 0x4f ||
                    bytes[i + 1] !== 0x67 ||
                    bytes[i + 2] !== 0x67 ||
                    bytes[i + 3] !== 0x53
                )
                    continue;

                if (i + 27 >= bytes.length) continue;
                const numSegments = bytes[i + 26];
                const dataStart = i + 27 + numSegments!;

                // OpusTags (comments)
                if (
                    bytes
                        .subarray(dataStart, dataStart + 8)
                        .every((b, i) => b === "OpusTags".charCodeAt(i))
                ) {
                    let pos = dataStart + 8;
                    const vendorLen = view.getUint32(pos, true);
                    pos += 4 + vendorLen;
                    const commentCount = view.getUint32(pos, true);
                    pos += 4;

                    for (let c = 0; c < commentCount; c++) {
                        const len = view.getUint32(pos, true);
                        pos += 4;
                        const comment = decoder.decode(bytes.subarray(pos, pos + len));
                        pos += len;

                        const eq = comment.indexOf("=");
                        const key = comment.slice(0, eq).toUpperCase();
                        const val = comment.slice(eq + 1);
                        if (key === "SAMPLE_RATE") sampleRate = parseInt(val);
                        if (key === "LOOP_START") loopStartSample = parseInt(val);
                        if (key === "LOOP_END") loopEndSample = parseInt(val);
                    }
                }

                if (sampleRate && loopStartSample && loopEndSample) break;
            }

            if (!isNaN(sampleRate!) && !isNaN(loopStartSample!) && !isNaN(loopEndSample!)) {
                loopStart = loopStartSample! / sampleRate!;
                loopEnd = loopEndSample! / sampleRate!;
            }
        } catch (e) {
            logger.warn(TAG, `Could not read loop metadata for "${file}", will loop full track`, e);
        }

        preloadMap.set(file, { audioBuffer, loopStart, loopEnd });
    }

    /**
     * Unload a preloaded file
     * @param file - URL of the sound file.
     */
    static unload(file: string): void {
        preloadMap.delete(file);
    }

    // TODO: return an ID?
    /**
     * Creates an audio element and adds it to the {@link audios}.
     * @param file - URL of the sound file.
     * @param onFinish - Callback invoked when the playback has finished.
     * @param onError - Callback invoked when error occurs.
     * @param crossOrigin - Cross origin setting.
     * @return Created audio element.
     */
    static add(
        file: string,
        onFinish?: () => void,
        onError?: (e: Error) => void,
        crossOrigin?: string,
    ): HTMLAudioElement {
        const audio = new Audio(file);

        audio.preload = "auto";
        // audio.autoplay = true;
        audio.crossOrigin = crossOrigin!;
        audioListenersWeakMap.set(audio, {
            ended: () => {
                this.dispose(audio);
                onFinish?.();
            },
            error: (e: ErrorEvent) => {
                this.dispose(audio);
                logger.warn(TAG, `Error occurred on "${file}"`, e.error);
                onError?.(e.error);
            },
        });
        audio.addEventListener("ended", audioListenersWeakMap.get(audio).ended);
        audio.addEventListener("error", audioListenersWeakMap.get(audio).error);

        this.audios.push(audio);

        return audio;
    }

    /**
     * Prepare preloaded looping audio for playback
     * @param file - URL of the sound file.
     * @returns LoopHandle for created audio buffer.
     */
    static addLooping(file: string): AudioLoopHandle {
        const preloaded = preloadMap.get(file);
        if (!preloaded) {
            throw new Error(`${TAG}: "${file}" has not been preloaded. Call preload() first.`);
        }

        const { audioBuffer, loopStart, loopEnd } = preloaded;
        const context = this.getContext();
        const gain = context.createGain();
        gain.connect(context.destination);

        const handle: AudioLoopHandle = {
            file,
            audioBuffer,
            gain,
            loopStart,
            loopEnd,
            _stopped: false,
        };
        this.loopHandles.push(handle);
        return handle;
    }

    /**
     * Plays the sound.
     * @param audio - An audio element.
     * @return Promise that resolves when the audio is ready to play, rejects when error occurs.
     */
    static play(audio: HTMLAudioElement): Promise<void> {
        return new Promise((resolve, reject) => {
            // see https://developers.google.com/web/updates/2017/09/autoplay-policy-changes
            audio.play()?.catch((e) => {
                audio.dispatchEvent(new ErrorEvent("error", { error: e }));
                reject(e);
            });

            if (audio.readyState === audio.HAVE_ENOUGH_DATA) {
                resolve();
            } else {
                audioCanplaythroughWeakMap.set(audio, resolve);
                audio.addEventListener("canplaythrough", resolve as () => void);
            }
        });
    }

    /**
     * Play a looping audio by LoopHandle
     * @param handle - LoopHandle of the audio buffer
     */
    static playLooping(handle: AudioLoopHandle): void {
        if (handle._stopped) {
            logger.warn(TAG, `playLooping called on stopped handle for "${handle.file}"`);
            return;
        }
        const context = this.getContext();

        const existing = audioBufferSourceWeakMap.get(handle);
        if (existing) {
            try {
                existing.stop();
            } catch (e) {
                logger.error(TAG, `Error stopping "${handle.file}"`, e);
            }
            existing.disconnect();
            audioBufferSourceWeakMap.delete(handle);
        }

        const source = context.createBufferSource();
        source.buffer = handle.audioBuffer;
        source.loop = true;
        source.loopStart = handle.loopStart;
        source.loopEnd = handle.loopEnd;
        source.connect(handle.gain);
        audioBufferSourceWeakMap.set(handle, source);

        source.start();
    }

    /**
     * Stop and clear a looping audio by LoopHandle
     * @param handle - LoopHandle of the audio buffer
     */
    static stopLooping(handle: AudioLoopHandle): void {
        handle._stopped = true;
        const existing = audioBufferSourceWeakMap.get(handle);
        if (existing) {
            try {
                existing.stop();
            } catch (e) {
                logger.error(TAG, `Error stopping "${handle.file}"`, e);
            }
            existing.disconnect();
            audioBufferSourceWeakMap.delete(handle);
        }
        handle.gain.disconnect();
        remove(this.loopHandles, handle);
    }

    /**
     * Get AudioContext of this SoundManager
     * @returns - AudioContext
     */
    static getContext(): AudioContext {
        /* Create or get the AudioContext */
        if (!audioContext || audioContext.state === "closed") {
            audioContext = new AudioContext();
        }
        return audioContext;
    }

    static addAnalyzer(audio: HTMLAudioElement): AnalyserNode {
        /* Create an AnalyserNode */
        const context = this.getContext();
        let source = audioSourceWeakMap.get(audio);
        if (!source) {
            source = context.createMediaElementSource(audio);
            audioSourceWeakMap.set(audio, source);
        }
        let analyser = audioAnalyserWeakMap.get(audio);
        if (!analyser) {
            analyser = context.createAnalyser();

            analyser.fftSize = 256;
            analyser.minDecibels = -90;
            analyser.maxDecibels = -10;
            analyser.smoothingTimeConstant = 0.85;

            source.connect(analyser);
            analyser.connect(context.destination);

            audioAnalyserWeakMap.set(audio, analyser);
            this.analysers.push(analyser);
        }
        return analyser;
    }

    /**
     * Get volume for lip sync
     * @param analyser - An analyzer element.
     * @return Returns value to feed into lip sync
     */
    static analyze(analyser: AnalyserNode): number {
        const pcmData = new Float32Array(analyser.fftSize);
        let sumSquares = 0.0;
        analyser.getFloatTimeDomainData(pcmData);

        for (const amplitude of pcmData) {
            sumSquares += amplitude * amplitude;
        }
        return parseFloat(Math.sqrt((sumSquares / pcmData.length) * 20).toFixed(1));
    }

    /**
     * Disposes an audio element and removes it from {@link audios}.
     * @param audio - An audio element.
     */
    static dispose(audio: HTMLAudioElement): void {
        audio.pause();
        audio.removeEventListener("ended", audioListenersWeakMap.get(audio)?.ended);
        audio.removeEventListener("error", audioListenersWeakMap.get(audio)?.error);
        audio.removeEventListener("canplaythrough", audioCanplaythroughWeakMap.get(audio));
        audioListenersWeakMap.delete(audio);
        audioCanplaythroughWeakMap.delete(audio);
        const analyser = audioAnalyserWeakMap.get(audio);
        audioAnalyserWeakMap.delete(audio);
        analyser?.disconnect();
        const source = audioSourceWeakMap.get(audio);
        audioSourceWeakMap.delete(audio);
        source?.disconnect();
        audio.removeAttribute("src");
        remove(this.analysers, analyser);
        remove(this.audios, audio);
    }

    /**
     * Destroys all managed audios.
     */
    static destroy(): void {
        // dispose() removes given audio from the array, so the loop must be backward
        for (let i = this.audios.length - 1; i >= 0; i--) {
            this.dispose(this.audios[i]!);
        }
        for (let i = this.loopHandles.length - 1; i >= 0; i--) {
            this.stopLooping(this.loopHandles[i]!);
        }
        preloadMap.clear();
        audioContext?.close();
        audioContext = null;
    }
}
