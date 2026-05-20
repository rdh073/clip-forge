const CPU_PROVIDER = 'cpu';

export function normalizeOrtProvider(value = process.env.CF_ORT_PROVIDER) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === CPU_PROVIDER) return CPU_PROVIDER;
  if (raw === 'gpu' || raw === 'nvidia') return 'cuda';
  if (raw === 'apple') return 'coreml';
  if (raw === 'directml') return 'dml';
  if (raw === 'trt') return 'tensorrt';
  return raw;
}

export function buildOrtProviderAttempts(value = process.env.CF_ORT_PROVIDER) {
  const provider = normalizeOrtProvider(value);
  if (provider === CPU_PROVIDER) return [CPU_PROVIDER];
  return [provider, CPU_PROVIDER];
}

export async function createOrtSessionWithFallback(ort, modelPath, opts = {}) {
  const attempts = buildOrtProviderAttempts(opts.provider);
  const errors = [];

  for (const provider of attempts) {
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        ...(opts.sessionOptions || {}),
        executionProviders: [provider],
      });
      return {
        session,
        provider,
        fallbackUsed: provider === CPU_PROVIDER && attempts[0] !== CPU_PROVIDER,
        fallbackReason: errors.length
          ? errors[errors.length - 1].provider + ': ' + errors[errors.length - 1].message
          : null,
      };
    } catch (e) {
      errors.push({
        provider,
        message: e && e.message ? e.message : String(e),
      });
    }
  }

  const detail = errors.map((e) => e.provider + ': ' + e.message).join('; ');
  throw new Error('onnx_session_create_failed: ' + detail);
}
