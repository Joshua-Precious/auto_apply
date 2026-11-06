export interface AppConfig {
  pepper: string;
  pepperVersion: number;
  maxActiveIntelligence: number;
  idempotencyTtlHours: number;
  retentionDays: number;
}

export function loadConfig(env = process.env): AppConfig {
  const pepper = env.API_KEY_PEPPER ?? '';
  if (pepper.length < 64 || !/^[a-f0-9]+$/i.test(pepper)) {
    throw new Error('API_KEY_PEPPER must be at least 32 random bytes encoded as hex');
  }
  const bounded = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid configuration: ${name}`);
    return value;
  };
  return {
    pepper,
    pepperVersion: bounded('API_KEY_PEPPER_VERSION', 1, 1, 1_000_000),
    maxActiveIntelligence: bounded('MAX_ACTIVE_INTELLIGENCE', 2, 1, 50),
    idempotencyTtlHours: bounded('IDEMPOTENCY_TTL_HOURS', 24, 1, 72),
    retentionDays: bounded('RETENTION_DAYS', 30, 1, 365),
  };
}
