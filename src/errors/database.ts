interface DatabaseErrorLike {
  code?: string;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as DatabaseErrorLike).code === '23505'
  );
}
