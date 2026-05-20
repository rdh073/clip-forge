const CPU_ENCODER = 'libx264';
const GPU_ENCODER = 'h264_nvenc';

export function normalizeFfmpegEncoder(value = process.env.CF_FFMPEG_ENCODER) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'cpu' || raw === 'x264' || raw === CPU_ENCODER) return CPU_ENCODER;
  if (raw === 'gpu' || raw === 'cuda' || raw === 'nvenc' || raw === GPU_ENCODER) return GPU_ENCODER;
  return raw;
}

export function buildVideoEncoderPlan(opts = {}) {
  const encoder = normalizeFfmpegEncoder(opts.encoder);
  const cpuArgs = buildCpuArgs(opts);

  if (encoder !== GPU_ENCODER) {
    return {
      encoder,
      args: encoder === CPU_ENCODER ? cpuArgs : ['-c:v', encoder],
      fallbackEncoder: null,
      fallbackArgs: null,
    };
  }

  return {
    encoder: GPU_ENCODER,
    args: buildNvencArgs(opts),
    fallbackEncoder: CPU_ENCODER,
    fallbackArgs: cpuArgs,
  };
}

export function buildFfmpegPlan(prefixArgs, suffixArgs, opts = {}) {
  const video = buildVideoEncoderPlan(opts);
  return {
    args: [...prefixArgs, ...video.args, ...suffixArgs],
    fallbackArgs: video.fallbackArgs ? [...prefixArgs, ...video.fallbackArgs, ...suffixArgs] : null,
    encoder: video.encoder,
    fallbackEncoder: video.fallbackEncoder,
  };
}

function buildCpuArgs(opts) {
  return [
    '-c:v', CPU_ENCODER,
    '-preset', opts.cpuPreset || 'fast',
    '-crf', String(opts.cpuCrf ?? 20),
  ];
}

function buildNvencArgs(opts) {
  const cpuCrf = Number(opts.cpuCrf ?? 20);
  const cq = opts.gpuCq ?? Math.min(28, Math.max(16, cpuCrf + 1));
  const preset = opts.gpuPreset || (opts.cpuPreset === 'slow' ? 'p5' : 'p4');
  return [
    '-c:v', GPU_ENCODER,
    '-preset', preset,
    '-cq', String(cq),
    '-b:v', '0',
  ];
}
