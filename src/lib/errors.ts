export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function gtmError(tool: string, err: unknown): never {
  throw new Error(`[${tool}] ${formatError(err)}`);
}
