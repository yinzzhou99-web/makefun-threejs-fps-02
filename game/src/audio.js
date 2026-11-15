// Sound, synthesised: no audio files. A noise burst through a band-pass is a gunshot, a
// short square blip is a hit tick, two tones are a round sting, and the bomb beeps on a
// timer the match owns. Everything is created lazily on the first user gesture, and every
// call is safe before that (it just stays silent).
export function createAudio() {
  let ctx = null;
  let master = null;

  function ensure() {
    if (ctx !== null) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      return true;
    } catch {
      return false;
    }
  }

  function noiseBurst({ at = 0, dur = 0.12, freq = 1800, q = 0.8, gain = 0.5, type = 'bandpass' }) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + at;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(g).connect(master);
    src.start(t0);
  }

  function tone({ at = 0, dur = 0.12, freq = 660, gain = 0.18, type = 'square' }) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  return {
    unlock() {
      if (ensure() && ctx.state === 'suspended') void ctx.resume();
    },
    shot(kind, distance = 0) {
      const fade = Math.max(0.12, 1 - distance / 60);
      if (kind === 'longshot') noiseBurst({ dur: 0.28, freq: 700, gain: 0.8 * fade });
      else if (kind === 'p9') noiseBurst({ dur: 0.09, freq: 2400, gain: 0.4 * fade });
      else if (kind === 'raptor') noiseBurst({ dur: 0.07, freq: 2100, gain: 0.42 * fade });
      else noiseBurst({ dur: 0.14, freq: 1500, gain: 0.55 * fade });
    },
    dryFire() {
      tone({ dur: 0.05, freq: 1200, gain: 0.1 });
    },
    reload() {
      tone({ dur: 0.05, freq: 500, gain: 0.12 });
      tone({ at: 0.16, dur: 0.05, freq: 800, gain: 0.12 });
    },
    hit(head) {
      tone({ dur: 0.06, freq: head ? 1560 : 1180, gain: 0.16 });
    },
    hurt() {
      noiseBurst({ dur: 0.1, freq: 300, gain: 0.3, type: 'lowpass' });
    },
    plantBeep(final) {
      tone({ dur: final ? 0.3 : 0.07, freq: final ? 1320 : 990, gain: 0.2 });
    },
    explosion() {
      noiseBurst({ dur: 0.9, freq: 120, gain: 1, type: 'lowpass' });
      noiseBurst({ dur: 0.4, freq: 500, gain: 0.5, type: 'lowpass' });
    },
    sting(win) {
      tone({ dur: 0.14, freq: win ? 660 : 392, gain: 0.16, type: 'triangle' });
      tone({ at: 0.15, dur: 0.22, freq: win ? 880 : 330, gain: 0.16, type: 'triangle' });
    },
    buy() {
      tone({ dur: 0.06, freq: 1040, gain: 0.12 });
    },
  };
}
