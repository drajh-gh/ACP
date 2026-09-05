export interface WorkerConfig {
  readonly systemDatabaseUrl: string;
  readonly applicationVersion: string;
  readonly executorId: string;
  readonly runMigrations: boolean;
}

export function parseWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerConfig {
  const systemDatabaseUrl = required(
    environment.ACP_DBOS_SYSTEM_DATABASE_URL,
    "ACP_DBOS_SYSTEM_DATABASE_URL",
  );
  const protocol = new URL(systemDatabaseUrl).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new TypeError("ACP_DBOS_SYSTEM_DATABASE_URL must be a PostgreSQL URL");
  }

  return {
    systemDatabaseUrl,
    applicationVersion: required(
      environment.ACP_APPLICATION_VERSION,
      "ACP_APPLICATION_VERSION",
    ),
    executorId: required(environment.ACP_EXECUTOR_ID, "ACP_EXECUTOR_ID"),
    runMigrations: parseBoolean(
      environment.ACP_DBOS_RUN_MIGRATIONS,
      "ACP_DBOS_RUN_MIGRATIONS",
      false,
    ),
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}
